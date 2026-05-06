/**
 * loop-tools.js — central dispatcher for loop-mode tool calls.
 *
 * This module owns three things:
 *
 *   1. REGISTRY — a map of tool name → execution function. The runtime
 *      asks the dispatcher to invoke a tool by name; the dispatcher
 *      raises a structured `ToolError(NOT_IMPLEMENTED)` for unknown
 *      names so the agent sees the failure and self-corrects rather
 *      than aborting the whole run.
 *
 *   2. TOOL_SCHEMAS — the OpenAI-style function schemas the loop sends
 *      to the model. The always-on `finalize` schema is included here
 *      for a single source of truth: the runtime's `FINALIZE_TOOL_SCHEMA`
 *      is re-exported so loop-runtime can keep building it directly,
 *      while `getEnabledToolSchemas(profile)` does the profile-driven
 *      filtering for chat / lorebook / memory / note tools.
 *
 *   3. `getEnabledToolSchemas(profile)` — derives the active schemas
 *      from `profile.tools.<namespace>.<verb>` flags. `finalize` is
 *      always emitted because the agent has no other terminator;
 *      everything else respects the profile flag.
 *
 * Task 8 introduces the dispatcher with chat tools wired in. Task 9
 * appends `lorebook.search` / `lorebook.get`. Task 10 adds memory tools.
 * Task 11 adds `note.add`.
 */

import { FINALIZE_TOOL_SCHEMA, ToolError } from './loop-runtime.js';
import { execChatReadRange, execChatSearch } from './loop-tools/chat.js';
import { execLorebookSearch, execLorebookGet } from './loop-tools/lorebook.js';
import { execMemorySearch, execMemoryListRecent, execMemoryGet } from './loop-tools/memory.js';
import { execNoteAdd } from './loop-tools/note.js';

/**
 * Map of fully-qualified tool name → async execution function.
 * Each implementation receives `(args, context)` and returns a JSON-
 * serializable result (or throws `ToolError` on user-facing failures).
 */
const REGISTRY = new Map();

/**
 * Array of OpenAI-style tool schemas (each shaped as
 * `{ type: 'function', function: { name, description, parameters } }`).
 * `getEnabledToolSchemas` filters this list per profile.
 */
const TOOL_SCHEMAS = [];

/** Internal: register a tool and its schema in one shot. */
function registerTool(name, exec, schema) {
    if (typeof exec !== 'function') {
        throw new Error(`[loop-tools] cannot register '${name}': exec must be a function.`);
    }
    REGISTRY.set(name, exec);
    if (schema) TOOL_SCHEMAS.push(schema);
}

// ---- chat namespace ------------------------------------------------------

registerTool('chat.read_range', execChatReadRange, {
    type: 'function',
    function: {
        name: 'chat.read_range',
        description: 'Read a contiguous range of chat floors. Negative indices count from the end (e.g. start=-5, end=-1 reads the last 5 floors). Maximum 50 floors per call.',
        parameters: {
            type: 'object',
            properties: {
                start: {
                    type: 'integer',
                    description: 'First floor to include (inclusive). Negative counts from end.',
                },
                end: {
                    type: 'integer',
                    description: 'Last floor to include (inclusive). Negative counts from end.',
                },
            },
            required: ['start', 'end'],
            additionalProperties: false,
        },
    },
});

registerTool('chat.search', execChatSearch, {
    type: 'function',
    function: {
        name: 'chat.search',
        description: 'Substring search across all chat floors. Case-insensitive. Returns matching floors with truncated previews; use chat.read_range to read full content for a specific floor.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Non-empty search string. Whitespace-only is rejected.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max results to return (default 10, max 50).',
                    minimum: 1,
                    maximum: 50,
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

// ---- lorebook namespace -------------------------------------------------

registerTool('lorebook.search', execLorebookSearch, {
    type: 'function',
    function: {
        name: 'lorebook.search',
        description: 'Substring search across all enabled lorebooks (World Info entries). Excludes entries already activated this turn so the agent does not rediscover what main-flow World Info already injected. Returns book + key + truncated preview per match.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Non-empty search string. Matched against entry content and key list.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max results to return (default 5, max 50).',
                    minimum: 1,
                    maximum: 50,
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

registerTool('lorebook.get', execLorebookGet, {
    type: 'function',
    function: {
        name: 'lorebook.get',
        description: 'Fetch a lorebook entry by key. Returns full content. Does NOT dedup against activated entries — use this when you need to quote an injected entry verbatim.',
        parameters: {
            type: 'object',
            properties: {
                entry_key: {
                    type: 'string',
                    description: 'Exact key string (case-sensitive) appearing in the entry\'s key array.',
                },
                book: {
                    type: 'string',
                    description: 'Optional: narrow by lorebook name (entry.world). First match wins if omitted.',
                },
            },
            required: ['entry_key'],
            additionalProperties: false,
        },
    },
});

// ---- memory namespace ---------------------------------------------------

registerTool('memory.search', execMemorySearch, {
    type: 'function',
    function: {
        name: 'memory.search',
        description: 'Lexical (substring) search over memory-graph nodes for the current chat. Excludes nodes already injected into the main model context this turn (always-inject + recall-selected). Returns id + preview + optional type/time per match.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Non-empty search string. Matched against node title and key fields.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max results to return (default 5, max 50).',
                    minimum: 1,
                    maximum: 50,
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

registerTool('memory.list_recent', execMemoryListRecent, {
    type: 'function',
    function: {
        name: 'memory.list_recent',
        description: 'Browse the most recent memory-graph nodes in time-descending order. Excludes already-injected nodes (same union as memory.search). Use this to scan timeline-recent context the model has not yet seen.',
        parameters: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    description: 'Max results to return (default 10, max 100).',
                    minimum: 1,
                    maximum: 100,
                },
            },
            additionalProperties: false,
        },
    },
});

registerTool('memory.get', execMemoryGet, {
    type: 'function',
    function: {
        name: 'memory.get',
        description: 'Fetch a memory-graph node by id, with direct neighbor ids and edge metadata. Does NOT dedup against the injected set — use this to inspect an injected node\'s neighbors.',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id from memory.search / memory.list_recent.',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
});

// ---- note namespace -----------------------------------------------------

registerTool('note.add', execNoteAdd, {
    type: 'function',
    function: {
        name: 'note.add',
        description: 'Append a persistent note (bound to the current chat) that survives across loop runs and is re-injected into your system prompt at the start of the next run. Use sparingly: for short reminders, intent commitments, or "I should ask the user about X next turn." Long-form context belongs in lorebook / memory-graph. Limit: 1KB UTF-8 per note, 50 notes total per chat (oldest pruned automatically).',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'Note body. Must be non-empty after whitespace trim and at most 1024 UTF-8 bytes.',
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
});

// ---- public API ----------------------------------------------------------

/**
 * Re-export of the runtime's finalize schema so dispatcher consumers have
 * a single import surface for "all loop tool schemas".
 */
export { FINALIZE_TOOL_SCHEMA };

/**
 * Dispatch a loop tool call by name. The runtime catches `ToolError`
 * and re-injects the structured failure into the messages array;
 * unknown tools surface as `ToolError(NOT_IMPLEMENTED)` so the agent
 * can pivot rather than the whole run aborting.
 *
 * @param {string} name — fully qualified tool name (e.g. 'chat.search')
 * @param {object} args — tool arguments
 * @param {object} context — extension context (chat, run-scoped state)
 * @returns {Promise<unknown>} JSON-serializable result for the tool message
 */
export async function executeLoopTool(name, args, context) {
    const exec = REGISTRY.get(String(name || ''));
    if (typeof exec !== 'function') {
        throw new ToolError(
            `Tool '${name}' is not implemented in this build.`,
            'NOT_IMPLEMENTED',
            'Pick a registered tool name or call finalize when you have enough information.',
        );
    }
    return exec(args && typeof args === 'object' ? args : {}, context || {});
}

/**
 * Build the OpenAI-style tools array from a sanitized loop profile.
 * `finalize` is always included; chat / lorebook / memory / note tools
 * follow `profile.tools.<namespace>.<verb>` flags. Unknown namespaces
 * are ignored (forward compatibility with future task adds).
 */
export function getEnabledToolSchemas(profile) {
    const flags = profile && typeof profile === 'object' ? (profile.tools || {}) : {};
    const out = [FINALIZE_TOOL_SCHEMA];
    for (const schema of TOOL_SCHEMAS) {
        const fullName = String(schema?.function?.name || '');
        if (!fullName) continue;
        const dot = fullName.indexOf('.');
        if (dot < 0) {
            // Top-level tool flag (e.g. note.add lives under flags.note.add,
            // but a hypothetical bare name would read flags[name] === true).
            if (flags?.[fullName]) out.push(schema);
            continue;
        }
        const ns = fullName.slice(0, dot);
        const verb = fullName.slice(dot + 1);
        if (flags?.[ns]?.[verb]) out.push(schema);
    }
    return out;
}

/**
 * @internal — exposed for tests. Returns the live REGISTRY map.
 */
export function __getRegistryForTest() {
    return REGISTRY;
}

/**
 * @internal — exposed for tests. Returns the live TOOL_SCHEMAS array
 * (excluding finalize, which the runtime owns directly).
 */
export function __getSchemasForTest() {
    return TOOL_SCHEMAS;
}
