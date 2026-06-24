// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Deterministic JSON serialization for tool-call arguments.
 *
 * Plain `JSON.stringify` preserves V8 insertion order, so two semantically
 * identical args objects ({a:1,b:2} vs {b:2,a:1}) serialize to different
 * strings — different cache-prefix bytes — which silently invalidates the
 * Anthropic prompt cache when the same tool call replays under a different
 * key order.
 *
 * Canonical form: object keys sorted lexicographically at every depth.
 * Arrays preserve order (array order is semantic). Non-object / non-array
 * values pass through. Cycles throw (same behavior as JSON.stringify).
 */

export function canonicalStringify(value) {
    return JSON.stringify(canonicalize(value));
}

/**
 * Wrap a tool-call args value for serialization into the OpenAI-compatible
 * `tool_calls[].function.arguments` string. Non-object values collapse to
 * `'{}'` (matches the prior `safeStringifyArgs` contract used across the
 * runtime files), so callers that previously coerced unknown shapes to
 * empty objects still see the same wire output.
 */
export function canonicalStringifyArgs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
    return canonicalStringify(value);
}

function canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = canonicalize(value[key]);
    }
    return sorted;
}
