// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator iteration studio — structured failure payloads shared by
 * the per-mode tool executors (`{ ok:false, error:'<code>', detail, action }`).
 */

import { diagnoseAnchorMiss } from '../../../iteration-library/anchor-diagnostic.js';

/**
 * Tool failure for a request that matches several stored ids.
 * @returns {{ ok: false, error: 'multiple_matches', detail: string, action: string, matches: string[] }}
 */
export function ambiguousIdFailure(operation, kind, id, matches) {
    const detail = `Skipped ${operation}: ${kind} id "${id}" is ambiguous, stored ids ${matches.map(match => JSON.stringify(match)).join(', ')} all match it after trimming. Rename them apart in the orchestration editor.`;
    return { ok: false, error: 'multiple_matches', detail, action: detail, matches };
}

/**
 * Build the extended failure payload for a `applyStringPatch` miss.
 * Attaches `match_diagnosis` (fuzzy layers over the live text) and
 * `next_step` (name-drop the per-mode read tool + target path) so the
 * iterating AI sees WHY its anchor missed and knows exactly which read
 * call resolves it without a second reasoning round-trip.
 *
 * Called from every `applyStringPatch` failure site inside the four
 * mode dispatchers. `mode` is one of 'director' / 'loop' / 'agenda' /
 * 'spec'; `targetPath` is a lodash-style hint of the path the AI can
 * pass to `luker_orch_read_<mode>_fields` to re-read the field it
 * tried to patch.
 */
export function buildPatchFailureEnvelope({ mode, targetPath, actionText, currentText, oldString, error, detail }) {
    if (error === 'not_found') {
        const diagnosis = diagnoseAnchorMiss(currentText, oldString);
        return {
            ok: false,
            error: 'not_found',
            detail: detail || 'oldString not present in the current text',
            currentLength: currentText.length,
            match_diagnosis: diagnosis,
            next_step: `Call luker_orch_read_${mode}_fields(['${targetPath}']) to see the current text, then re-issue the patch.`,
            action: actionText,
        };
    }
    return {
        ok: false,
        error,
        detail,
        action: actionText,
    };
}
