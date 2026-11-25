// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Execution modes that own a preset library and an active-preset slot.
 * `single` is an execution mode without a preset library and is not part
 * of this list (see `ORCH_EXECUTION_MODES` in defaults.js). Import-free so
 * every orchestrator module can use it without cycles.
 */
export const ORCH_PRESET_MODES = Object.freeze(['spec', 'agenda', 'loop', 'director']);

/**
 * Build `{ spec, agenda, loop, director }` with `factory(mode)` per key.
 * Returns a fresh object each call, so callers can mutate it.
 */
export function makeModeMap(factory) {
    const out = {};
    for (const mode of ORCH_PRESET_MODES) out[mode] = factory(mode);
    return out;
}
