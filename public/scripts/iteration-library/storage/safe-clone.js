// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Deep clone that survives ST's live character records.
 *
 * The live character shape carries non-cloneable refs (browser-side proxy
 * descriptors on the shared `context.characters[i]` reference) that make
 * `structuredClone` throw `DataCloneError`. The bus snapshot pair must be
 * a value clone — holding a live ref would let later commits silently
 * mutate the propose-time `before`, defeating drift detection. Falls
 * through to JSON for those cases; nothing in the editor pipeline carries
 * functions, Dates, or other JSON-lossy shapes.
 *
 * Lifted from CEA so other adapters can opt in once they touch live ST
 * records (CPA / MG / orch currently only clone bus state, which is plain
 * JSON, so they still use bare `structuredClone`).
 */
export function safeClone(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
}
