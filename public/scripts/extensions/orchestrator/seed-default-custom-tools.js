// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Seed helper for default Layer-3 customTools.
 *
 * Called from each profile's sanitizer (loop / spec / agenda / director).
 * Policy:
 *   - If `source.seededDefaultCustomTools === true`, the seed has
 *     already run for this profile — never re-seed. This is what makes
 *     "user deleted the default tool" stick: the flag stays true even
 *     when customTools[] becomes empty again.
 *   - If `source.seededDefaultCustomTools !== true` AND the sanitized
 *     `customTools` array is empty, inject DEFAULT_CUSTOM_TOOLS once
 *     and return the flag flipped to true.
 *   - If the user already has customTools (even just one), still flip
 *     the seed flag to true so a later deletion doesn't trigger seeding.
 *
 * Returns `{ customTools, seededDefaultCustomTools }` — caller must
 * spread both into the output profile.
 */

import { sanitizeCustomTools } from './custom-tools-sanitize.js';
import { DEFAULT_CUSTOM_TOOLS } from './default-custom-tools.js';

/**
 * @param {object} source — the un-sanitized input profile
 * @param {Array<object>} sanitizedTools — `sanitizeCustomTools(source.customTools)` result
 * @returns {{ customTools: Array<object>, seededDefaultCustomTools: boolean }}
 */
export function seedDefaultCustomToolsIfNeeded(source, sanitizedTools) {
    const alreadySeeded = source && source.seededDefaultCustomTools === true;
    const safeTools = Array.isArray(sanitizedTools) ? sanitizedTools : [];
    if (alreadySeeded) {
        return { customTools: safeTools, seededDefaultCustomTools: true };
    }
    if (safeTools.length > 0) {
        // First-time profile with the user already having authored a tool
        // before defaults were seeded — respect their wishes, just flip
        // the flag so we don't seed later when they delete one.
        return { customTools: safeTools, seededDefaultCustomTools: true };
    }
    // Empty + never seeded → inject defaults. Re-sanitize through the
    // shared sanitizer so bodies / parameters / etc. are normalized the
    // same way user-authored entries are.
    const seeded = sanitizeCustomTools(DEFAULT_CUSTOM_TOOLS.map(t => ({ ...t })));
    return { customTools: seeded, seededDefaultCustomTools: true };
}

/**
 * Merge default customTools into an existing profile in place, used by
 * the "Import default custom tools" button. Names that already exist on
 * the profile are skipped by default; pass `overwrite: true` to replace
 * them. Returns `{ added: string[], overwritten: string[], skipped: string[] }`
 * so the caller can summarize the import for the user.
 *
 * @param {object} profile — must have a `customTools` array (created if missing)
 * @param {{ overwrite?: boolean }} [opts]
 * @returns {{ added: string[], overwritten: string[], skipped: string[] }}
 */
export function importDefaultCustomTools(profile, { overwrite = false } = {}) {
    if (!profile || typeof profile !== 'object') {
        throw new TypeError('importDefaultCustomTools: profile must be an object');
    }
    if (!Array.isArray(profile.customTools)) profile.customTools = [];
    const added = [];
    const overwritten = [];
    const skipped = [];
    const byName = new Map(profile.customTools.map((t, i) => [String(t?.name || ''), i]));
    for (const def of DEFAULT_CUSTOM_TOOLS) {
        const name = String(def.name);
        const existingIdx = byName.get(name);
        if (existingIdx === undefined) {
            profile.customTools.push({ ...def });
            added.push(name);
            continue;
        }
        if (overwrite) {
            profile.customTools[existingIdx] = { ...def };
            overwritten.push(name);
        } else {
            skipped.push(name);
        }
    }
    // Re-sanitize so any out-of-spec field in the default is normalized.
    profile.customTools = sanitizeCustomTools(profile.customTools);
    // Importing also counts as "seeding has happened" — keep the flag
    // pinned on so the seed-on-empty path doesn't fire later.
    profile.seededDefaultCustomTools = true;
    return { added, overwritten, skipped };
}
