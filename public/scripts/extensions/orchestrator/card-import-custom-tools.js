// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Data-layer helpers for the "imported character card carries
 * orchestrator customTools[]" safety review.
 *
 * /api/characters/import writes `character.data.extensions.orchestrator`
 * verbatim. A third-party card can therefore embed Layer-3 customTools —
 * arbitrary JavaScript bodies that the orchestrator runtime will register
 * and execute on first dispatch. The orchestrator already gates the
 * "apply iter-studio session → character" path through
 * `character-import-tools-review.js`; this module covers the same risk
 * surface for the file-drop / `/api/characters/import` path.
 *
 * `collectCustomToolsFromCardExtension(ext)` walks both the new
 * `presetLibraries.<mode>.<id>.[spec.]customTools` shape AND the legacy
 * `override.<mode>.[spec.]customTools` shape, returning a flat list of
 * tools plus an opaque `locations` list describing where to clear them.
 *
 * `stripCustomToolsFromCardExtension(ext, locations)` sets every
 * collected location's `customTools` to `[]`, leaving the rest of the
 * profile (system prompts, tool flags, etc.) untouched. Used when the
 * user picks "import without tools" in the review popup.
 *
 * Pure data layer — no DOM, no eventSource, no settings, no I/O. The
 * popup + CHARACTER_IMPORTED wiring sits on top in main.js.
 */

const ALL_MODES = ['spec', 'agenda', 'loop', 'director'];

function isNonNullObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getCustomToolsFieldRef(container, mode) {
    // Spec mode wraps everything under .spec — including customTools.
    // Every other mode keeps customTools at the container root.
    if (mode === 'spec') {
        if (!isNonNullObject(container?.spec)) return null;
        return { holder: container.spec, key: 'customTools' };
    }
    if (!isNonNullObject(container)) return null;
    return { holder: container, key: 'customTools' };
}

function readSanitizedToolList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        if (!isNonNullObject(entry)) continue;
        // We do not run the full custom-tools-sanitize.js pass here —
        // that lives in the per-mode profile sanitizers and would
        // import a transitive graph this module deliberately avoids.
        // The review popup only needs name/mode/description/body for
        // display; runtime sanitization happens on the read side when
        // the profile is finally loaded for a run.
        const name = typeof entry.name === 'string' ? entry.name : '';
        if (!name) continue;
        out.push(entry);
    }
    return out;
}

/**
 * @param {object|null|undefined} ext — `character.data.extensions.orchestrator` blob.
 * @returns {{ tools: object[], locations: Array<{ holder: object, key: string }> }}
 */
export function collectCustomToolsFromCardExtension(ext) {
    if (!isNonNullObject(ext)) return { tools: [], locations: [] };
    const tools = [];
    const locations = [];
    const visit = (container, mode) => {
        const ref = getCustomToolsFieldRef(container, mode);
        if (!ref) return;
        const sanitized = readSanitizedToolList(ref.holder[ref.key]);
        if (sanitized.length === 0) return;
        tools.push(...sanitized);
        locations.push(ref);
    };
    // New shape: presetLibraries.<mode>.<id>
    const libraries = isNonNullObject(ext.presetLibraries) ? ext.presetLibraries : null;
    if (libraries) {
        for (const mode of ALL_MODES) {
            const lib = libraries[mode];
            if (!isNonNullObject(lib)) continue;
            for (const presetId of Object.keys(lib)) {
                visit(lib[presetId], mode);
            }
        }
    }
    // Legacy shape: override.<mode>
    const override = isNonNullObject(ext.override) ? ext.override : null;
    if (override) {
        // Legacy spec keeps its customTools under override.spec.customTools.
        if (isNonNullObject(override.spec)) {
            const ref = { holder: override.spec, key: 'customTools' };
            const sanitized = readSanitizedToolList(ref.holder[ref.key]);
            if (sanitized.length > 0) {
                tools.push(...sanitized);
                locations.push(ref);
            }
        }
        for (const mode of ALL_MODES) {
            if (mode === 'spec') continue;
            visit(override[mode], mode);
        }
    }
    return { tools, locations };
}

/**
 * Clear `customTools` at every location returned by a prior
 * `collectCustomToolsFromCardExtension` call. Mutates `ext` in place.
 *
 * @param {object} ext — same blob passed to collect.
 * @param {Array<{ holder: object, key: string }>} locations — opaque
 *     list from collect; do not synthesize by hand.
 */
export function stripCustomToolsFromCardExtension(ext, locations) {
    if (!isNonNullObject(ext) || !Array.isArray(locations)) return;
    for (const loc of locations) {
        if (!loc || typeof loc !== 'object') continue;
        if (!isNonNullObject(loc.holder) || typeof loc.key !== 'string') continue;
        loc.holder[loc.key] = [];
    }
}

/**
 * Pure decision step: given a card's orchestrator extension blob and
 * the user's three-way review decision, return the action to take and
 * (for the strip path) the post-strip blob to persist.
 *
 * Separated from the popup + persist side effects so it can be
 * unit-tested without stubbing the popup, the eventSource, or the
 * character write API.
 *
 * @param {object|null|undefined} ext
 * @param {'with' | 'without' | 'cancel'} decision
 * @returns {{ action: 'keep' | 'drop' | 'strip', nextExt: object | null }}
 *   - 'keep'  : no persistence needed (tools stay as imported)
 *   - 'drop'  : write null to wipe the orchestrator blob from the card
 *   - 'strip' : write `nextExt` (a clone with every customTools[] cleared)
 */
export function planImportedCardCustomToolsReview(ext, decision) {
    if (decision === 'with') return { action: 'keep', nextExt: null };
    if (decision === 'cancel') return { action: 'drop', nextExt: null };
    if (decision !== 'without') return { action: 'keep', nextExt: null };
    if (!isNonNullObject(ext)) return { action: 'keep', nextExt: null };
    const nextExt = structuredClone(ext);
    const { locations } = collectCustomToolsFromCardExtension(nextExt);
    stripCustomToolsFromCardExtension(nextExt, locations);
    return { action: 'strip', nextExt };
}
