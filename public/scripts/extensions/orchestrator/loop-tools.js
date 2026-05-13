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
 * appends `lorebook_search` / `lorebook_get`. Task 10 adds memory tools.
 * Task 11 adds `note_add`.
 *
 * Tool names use `<namespace>_<verb>` (e.g. `chat_read_range`) because
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` rejects dots.
 * The profile flag tree still nests as `tools.<ns>.<verb>` — only the
 * LLM-visible name is flat. See `createPersistentToolCallPayload` and
 * `executeLoopTool` for the legacy-`<ns>.<verb>` migration shim.
 */

import { FINALIZE_TOOL_SCHEMA, ToolError } from './loop-runtime.js';
import { execChatReadRange, execChatSearch } from './loop-tools/chat.js';
import { execLorebookSearch, execLorebookGet } from './loop-tools/lorebook.js';
import { execMemorySearch, execMemoryListRecent, execMemoryGet } from './loop-tools/memory.js';
import { execNoteAdd, execNoteDelete } from './loop-tools/note.js';
import { execSearchSearch, execSearchVisit } from './loop-tools/search.js';

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

registerTool('chat_read_range', execChatReadRange, {
    type: 'function',
    function: {
        name: 'chat_read_range',
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

registerTool('chat_search', execChatSearch, {
    type: 'function',
    function: {
        name: 'chat_search',
        description: 'Substring search across all chat floors. Case-insensitive. Returns matching floors with truncated previews; use chat_read_range to read full content for a specific floor.',
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

registerTool('lorebook_search', execLorebookSearch, {
    type: 'function',
    function: {
        name: 'lorebook_search',
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

registerTool('lorebook_get', execLorebookGet, {
    type: 'function',
    function: {
        name: 'lorebook_get',
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

registerTool('memory_search', execMemorySearch, {
    type: 'function',
    function: {
        name: 'memory_search',
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

registerTool('memory_list_recent', execMemoryListRecent, {
    type: 'function',
    function: {
        name: 'memory_list_recent',
        description: 'Browse the most recent memory-graph nodes in time-descending order. Excludes already-injected nodes (same union as memory_search). Use this to scan timeline-recent context the model has not yet seen.',
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

registerTool('memory_get', execMemoryGet, {
    type: 'function',
    function: {
        name: 'memory_get',
        description: 'Fetch a memory-graph node by id, with direct neighbor ids and edge metadata. Does NOT dedup against the injected set — use this to inspect an injected node\'s neighbors.',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id from memory_search / memory_list_recent.',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
});

// ---- note namespace -----------------------------------------------------

registerTool('note_add', execNoteAdd, {
    type: 'function',
    function: {
        name: 'note_add',
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

registerTool('note_delete', execNoteDelete, {
    type: 'function',
    function: {
        name: 'note_delete',
        description: 'Delete persisted notes by their 1-based positions in the "## Previous Notes" block of your system prompt (the same numbering you see at run start). Use this to prune notes whose role is exhausted: foreshadowing has fired, the character beat has happened, the setting was superseded by later events, or several notes have collapsed into a duplicate. Out-of-range or non-integer indexes are rejected with a structured error so you can correct on the next round.',
        parameters: {
            type: 'object',
            properties: {
                indexes: {
                    type: 'array',
                    description: 'Non-empty array of 1-based positive integers. Each must match a current entry in the "## Previous Notes" block.',
                    items: { type: 'integer', minimum: 1 },
                    minItems: 1,
                },
            },
            required: ['indexes'],
            additionalProperties: false,
        },
    },
});

// ---- search namespace ---------------------------------------------------

registerTool('search_search', execSearchSearch, {
    type: 'function',
    function: {
        name: 'search_search',
        description: 'Web search via the search-tools plugin (DuckDuckGo / SearXNG / Brave, depending on plugin settings). Use only when the user asks about current events, fresh facts, or external information not present in chat / lorebook / memory. Returns provider-shaped results (typically a list of {title, url, snippet}). Follow up with search_visit on a specific URL to read full readable text.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Non-empty search query. Whitespace-only is rejected.',
                },
                max_results: {
                    type: 'integer',
                    description: 'Maximum number of results (1-20). Provider may cap further.',
                    minimum: 1,
                    maximum: 20,
                },
                safe_search: {
                    type: 'string',
                    enum: ['off', 'moderate', 'strict'],
                    description: 'Safe-search level. Defaults to plugin settings.',
                },
                time_range: {
                    type: 'string',
                    enum: ['day', 'week', 'month', 'year'],
                    description: 'Optional time filter. Omit for no filter.',
                },
                region: {
                    type: 'string',
                    description: 'Optional provider-specific locale or region hint.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

registerTool('search_visit', execSearchVisit, {
    type: 'function',
    function: {
        name: 'search_visit',
        description: 'Fetch one webpage discovered via search_search and return its readable text. Use sparingly: prefer the search snippet when it already answers the question.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'HTTP/HTTPS page URL.',
                },
                max_chars: {
                    type: 'integer',
                    description: 'Maximum output characters (0-50000). 0 means no truncation.',
                    minimum: 0,
                    maximum: 50000,
                },
            },
            required: ['url'],
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
 * @param {string} name — fully qualified tool name (e.g. 'chat_search').
 *                        Legacy `chat.search` names from pre-rename
 *                        persisted history are normalized to `_` form
 *                        before dispatch so old chats keep replaying.
 * @param {object} args — tool arguments
 * @param {object} context — extension context (chat, run-scoped state)
 * @returns {Promise<unknown>} JSON-serializable result for the tool message
 */
export async function executeLoopTool(name, args, context) {
    const normalized = String(name || '').replace(/\./g, '_');
    const exec = REGISTRY.get(normalized);
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
 * follow `profile.tools.<namespace>.<verb>` flags. The schema's flat
 * `<ns>_<verb>` tool name is split on the **first** underscore to
 * recover the profile path (so `memory_list_recent` reads
 * `flags.memory.list_recent`). Unknown namespaces are ignored
 * (forward compatibility with future task adds).
 */
export function getEnabledToolSchemas(profile) {
    const flags = profile && typeof profile === 'object' ? (profile.tools || {}) : {};
    const out = [FINALIZE_TOOL_SCHEMA];
    for (const schema of TOOL_SCHEMAS) {
        const fullName = String(schema?.function?.name || '');
        if (!fullName) continue;
        const sep = fullName.indexOf('_');
        if (sep < 0) {
            // Top-level tool flag (e.g. a hypothetical bare name reads
            // flags[name] === true).
            if (flags?.[fullName]) out.push(schema);
            continue;
        }
        const ns = fullName.slice(0, sep);
        const verb = fullName.slice(sep + 1);
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
