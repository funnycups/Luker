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
 * Task 11 adds `note_open` / `note_close`.
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
import { execMemoryListCandidates, execMemoryEdgeSummary, execMemoryNodeBrief,
    execMemoryExpandSeeds, execMemoryRank, execMemorySchema } from './loop-tools/memory.js';
import { execNoteOpen, execNoteClose } from './loop-tools/note.js';
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
// Read-api pipeline tools. They mirror the inputs the native recall LLM
// sees so a director sub-agent (or the loop main agent) can reproduce an
// LLM-grade recall pass.

registerTool('memory_list_candidates', execMemoryListCandidates, {
    type: 'function',
    function: {
        name: 'memory_list_candidates',
        description: 'Enumerate the visible memory-graph candidate pool — the same pool the memory-graph\'s own recall LLM sees. Returns { candidates: [{ id, type, level, title, seqTo, semanticDepth }] } in recency-first order (seqTo desc, semanticDepth desc). Use this as the FIRST step of a recall pipeline.',
        parameters: {
            type: 'object',
            properties: {
                seq_window: {
                    type: 'object',
                    properties: {
                        from: { type: 'integer', description: 'Inclusive lower bound on node seqTo.' },
                        to: { type: 'integer', description: 'Inclusive upper bound on node seqTo.' },
                    },
                    additionalProperties: false,
                    description: 'Optional seq range to narrow the pool.',
                },
                types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional node-type filter (e.g. ["event", "character_sheet"]).',
                },
                exclude_recent_messages: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Drop nodes inside the recent-N raw turns window so freshly-injected context is not duplicated.',
                },
            },
            additionalProperties: false,
        },
    },
});

registerTool('memory_edge_summary', execMemoryEdgeSummary, {
    type: 'function',
    function: {
        name: 'memory_edge_summary',
        description: 'Get a node\'s edge_summary: { degree, relations: [{ relation, direction, count }], sample_neighbors: [{ id, type, title }] }. The native recall LLM uses this structural signal; reach for it when a brief is overkill and you just need "is this node a hub?".',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id from memory_list_candidates / memory_rank.',
                },
                edge_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relation-type filter.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Sample-neighbors cap (default 8).',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
});

registerTool('memory_node_brief', execMemoryNodeBrief, {
    type: 'function',
    function: {
        name: 'memory_node_brief',
        description: 'Get the canonical recall-side brief for one node: { id, title, summary, keyValues, rowValues, toSeq, childCount, exposure, edgeSummary, alwaysInject }. This is the SAME per-row format the memory-graph recall LLM sees. Returns { brief: null } when the node does not exist or is archived.',
        parameters: {
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'Node id to fetch the brief for.',
                },
                include_edge_summary: {
                    type: 'boolean',
                    description: 'Include edge_summary in the brief (default true). Set false to save tokens when you only need the textual fields.',
                },
                edge_summary_limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'sample_neighbors cap inside the embedded edge_summary (default 8).',
                },
            },
            required: ['node_id'],
            additionalProperties: false,
        },
    },
});

registerTool('memory_expand_seeds', execMemoryExpandSeeds, {
    type: 'function',
    function: {
        name: 'memory_expand_seeds',
        description: 'BFS-expand from seed ids along children + projected edges (default 1 hop). Returns { nodes: [{ id, type, level, title, seqTo }] } for the union of seeds + reachable nodes. Use SPARINGLY: when a brief is on-topic but compressed (high_only exposure, large childCount) and you need to surface specific children.',
        parameters: {
            type: 'object',
            properties: {
                seed_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Non-empty list of node ids to expand around.',
                },
                hops: {
                    type: 'integer',
                    minimum: 1,
                    description: 'BFS depth (default 1). Keep low; wide drilling wastes budget.',
                },
                edge_types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relation-type filter for projected edges.',
                },
                include_children: {
                    type: 'boolean',
                    description: 'Include hierarchical children (rollup → leaves). Default true.',
                },
                exclude_internal: {
                    type: 'boolean',
                    description: 'Drop nodes reached only through contains / semantic_contains internal edges. Default false (mirrors native expandRouteCandidates).',
                },
            },
            required: ['seed_ids'],
            additionalProperties: false,
        },
    },
});

registerTool('memory_rank', execMemoryRank, {
    type: 'function',
    function: {
        name: 'memory_rank',
        description: 'Rank active nodes by recency / vector / keyword / hybrid. Returns { ranked: [{ id, type, title, seqTo, score, scoreMode }] }. Use this BEFORE fetching briefs when the candidate pool is large; the shortlist tells you which nodes to call memory_node_brief on.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'One-line topical summary (from the task brief). Required for vector / keyword / hybrid modes.',
                },
                mode: {
                    type: 'string',
                    enum: ['recency', 'vector', 'keyword', 'hybrid'],
                    description: 'Ranking mode. Use "recency" when no semantic axis is given; "hybrid" combines vector + keyword 50/50 (falls back to recency if vector / keyword yield nothing).',
                },
                types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional node-type filter.',
                },
                k: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Max ranked results to return (default 20).',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

registerTool('memory_schema', execMemorySchema, {
    type: 'function',
    function: {
        name: 'memory_schema',
        description: 'Return the active node-type schema: { types: [{ type, tableName, tableColumns, requiredColumns, primaryKeyColumns, forceUpdate, alwaysInject, editable, compressionMode }] }. This is the SAME schema_overview the native recall LLM sees. Read once at the start of a recall pass to understand which fields are key vs detail and which types use hierarchical compression.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
});

// ---- note namespace -----------------------------------------------------

registerTool('note_open', execNoteOpen, {
    type: 'function',
    function: {
        name: 'note_open',
        description: 'Open a new plot-author note (foreshadowing, promise, chapter outline). Returns its id. The note shows up in your "## Open Notes" block until you close it.',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'The note content. Short or long; max 16KB UTF-8.',
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
});

registerTool('note_close', execNoteClose, {
    type: 'function',
    function: {
        name: 'note_close',
        description: 'Close an open note by id (e.g. it has been deployed or is no longer needed). Optional one-line reason.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The note id visible in the Open Notes block.',
                },
                reason: {
                    type: 'string',
                    description: 'Optional one-line closure reason.',
                },
            },
            required: ['id'],
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
 * recover the profile path (so `memory_list_candidates` reads
 * `flags.memory.list_candidates`). Unknown namespaces are ignored
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
