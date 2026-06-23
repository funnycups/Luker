// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Strict optional-string field accessor shared by every per-tool
 * patcher in main.js's `executeXxxIterationToolCalls` executors
 * (set_director_main_agent / set_director_subagent / set_agenda_agent /
 * set_node, …).
 *
 * Semantics:
 *   - key absent       → returns `undefined` (caller inherits existing)
 *   - key present + ok → returns the string
 *   - key present + ! → THROWS `invalid_args` with a `<tool>:` prefix
 *
 * Calling-side contract: invoke inside a `try { ... } catch (err) { ...
 * pushToolResult({ok:false, error:'invalid_args', detail: err.message});
 * continue; }`. The catch then surfaces a real OpenAI-protocol tool
 * reply the AI can read.
 *
 * Previously the typeof guard silently substituted the existing value
 * on type mismatch (`typeof args.X === 'string' ? X : existing.X`),
 * collapsing onto the iter-studio's misleading "already matches" noop
 * — the AI never learned its arg was the wrong type and re-emitted
 * the same broken call.
 *
 * Tested in tests/orchestrator/iter-arg-validator.test.js.
 */
export function readIterationStringArg(args, key, toolName) {
    if (args == null || typeof args !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(args, key)) return undefined;
    const value = args[key];
    if (typeof value !== 'string') {
        throw new Error(`${toolName}: invalid_args — ${key} must be a string, got ${typeof value}.`);
    }
    return value;
}
