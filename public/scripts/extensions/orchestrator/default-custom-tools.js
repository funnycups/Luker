// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Default Layer-3 customTools shipped with new orchestrator profiles.
 *
 * The seed mechanism in `seed-default-custom-tools.js` injects this list
 * into a fresh profile's `customTools[]` exactly once (tracked via a
 * `seededDefaults` flag on the profile so user-deleted entries are not
 * re-inserted). The same list also backs the "Import default custom
 * tools" button in the orchestration editor, which merges by name and
 * lets the user choose whether to overwrite an existing tool with the
 * same name.
 *
 * Each entry has the same shape as a user-authored customTool:
 *   { name, displayName, description, mode, parameters, body, simulateBody }
 *
 * Bodies are async JavaScript stored as strings, compiled at runtime by
 * `per-run-custom-tools.js` into `new AsyncFunction('args', 'ctx', body)`.
 * They can call other tools through the `ctx.__invokeLoopTool(name, args)`
 * seam — see `attachToolContext` in `loop-runtime.js`.
 *
 * Why ship defaults at all: customTools have an entry barrier (you need
 * to learn the `(args, ctx)` shape and what's on ctx before you can write
 * anything useful). One worked example showing the agent → customTool →
 * Layer-1 wrapper pattern teaches more than three pages of doc.
 */

/**
 * Registered defaults. Add a new entry here to ship it; the seed +
 * import-button paths pick it up automatically.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   displayName: string,
 *   description: string,
 *   mode: 'read' | 'write',
 *   parameters: object,
 *   body: string,
 *   simulateBody?: string,
 * }>}
 */
export const DEFAULT_CUSTOM_TOOLS = Object.freeze([
    {
        name: 'select_lore_for_turn',
        displayName: 'Select lore for this turn',
        description: 'Force a small set of dormant lorebook entries into the main model\'s <world_info> channel for THIS turn. Thin wrapper around the builtin lorebook_force_activate — adds a one-line summary of what landed where so the loop trace stays legible. Use after lorebook_list / lorebook_search has shortlisted dormant uids. Bypasses the World Info token budget; push only what the turn truly needs.',
        mode: 'write',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: 'Target world book name (entry.world). Get from world_book_list / lorebook_list.',
                },
                uids: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Uids of dormant entries to surface for the main model this turn.',
                },
                reason: {
                    type: 'string',
                    description: 'Optional one-line note explaining WHY these uids were picked — written into the summary so the trace is auditable.',
                },
            },
            required: ['book_name', 'uids'],
            additionalProperties: false,
        },
        body: [
            '// Delegate to the Layer-1 builtin via the ctx invoke seam.',
            '// This pattern (customTool wraps builtin + adds bookkeeping) is',
            '// the recommended way to compose Layer-1 tools from Layer-3.',
            'if (typeof ctx.__invokeLoopTool !== "function") {',
            '    return { ok: false, error: "ctx.__invokeLoopTool is not available — this customTool requires the orchestrator runtime." };',
            '}',
            'const out = await ctx.__invokeLoopTool("lorebook_force_activate", {',
            '    book_name: args.book_name,',
            '    uids: args.uids,',
            '});',
            'const summary = (out?.activated || []).map(e =>',
            '    `[${out.book}] uid=${e.uid} (${e.comment || "no-comment"}) → ${e.route}, ${e.chars} chars`',
            ').join("\\n");',
            'return {',
            '    ok: !!out?.ok,',
            '    activated_count: (out?.activated || []).length,',
            '    skipped_count: (out?.skipped || []).length,',
            '    summary: summary || "no entries activated",',
            '    reason: args.reason || "",',
            '    raw: out,',
            '};',
        ].join('\n'),
        simulateBody: [
            '// Simulation: report what would have been forced, without mutating',
            '// the WI payload. Lets simulation review trace the call.',
            'return {',
            '    ok: true,',
            '    simulated: true,',
            '    activated_count: Array.isArray(args.uids) ? args.uids.length : 0,',
            '    skipped_count: 0,',
            '    summary: `would force ${Array.isArray(args.uids) ? args.uids.length : 0} entries into ${args.book_name}`,',
            '    reason: args.reason || "",',
            '};',
        ].join('\n'),
    },
]);
