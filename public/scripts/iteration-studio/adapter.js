/**
 * IterationStudio — Adapter contract (v2, IDE-style).
 *
 * The shell is an extension-agnostic AI iteration workbench. Per-extension
 * behavior — what's being edited, which tools edit it, how state persists,
 * how the UI looks — comes from an Adapter that conforms to this contract.
 *
 * The shell lives in `public/scripts/iteration-studio/`. Reference adapters:
 *   - public/scripts/extensions/orchestrator/iteration-adapter.js
 *   - public/scripts/extensions/memory-graph/schema-adapter.js
 *
 * This file is JSDoc-only and exports nothing at runtime.
 *
 * @see ../lib/edits/types.d.ts for Edit / Conflict types from the edits lib.
 */

/**
 * @typedef {Object} ToolDefinition
 * OpenAI-style function tool definition.
 * @property {'function'} type
 * @property {Object} function
 * @property {string} function.name
 * @property {string} function.description
 * @property {Object} function.parameters
 */

/**
 * @typedef {Object} ToolResult
 * @property {string} tool_call_id
 * @property {string} content
 */

/**
 * @typedef {Object} ExecutionResult
 * @property {string[]} actions
 * @property {ToolResult[]} toolResults
 * @property {boolean} finalized
 * @property {string} finalizeSummary
 * @property {boolean} continueRequested
 * @property {boolean} changed
 * @property {Object[]} appliedEdits         Op-typed edits successfully written to live this turn.
 */

/**
 * @typedef {Object} SessionMeta
 * @property {string} id
 * @property {string} title
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} SessionMessage
 * @property {string} id
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {boolean} [auto]
 * @property {number} at
 *
 * Tool-turn fields (assistant only):
 * @property {Object[]} [tool_calls]
 * @property {Object[]} [pendingToolCalls]
 * @property {Object[]} [executionToolCalls]
 * @property {ToolResult[]} [tool_results]
 * @property {string} [toolSummary]
 * @property {'pending'|'completed'|'rejected'} [toolState]
 *
 * IDE-style apply log:
 * @property {Object[]} [appliedEdits]       Op-typed edits this message wrote to live.
 * @property {boolean} [rolledBack]          True after the user rolled back to before this message.
 */

/**
 * @typedef {Object} PendingApproval
 * @property {string} messageId
 * @property {string} assistantText
 * @property {Object[]} toolCalls
 * @property {Object[]} executionToolCalls
 * @property {Object[]} proposedEdits        Pre-conflict-resolution edits, for projection render.
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} mode
 * @property {string} sourceScope
 * @property {string} sourceAvatar
 * @property {string} sourceName
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {SessionMessage[]} messages
 * @property {PendingApproval|null} pendingApproval
 * @property {*} [surfaceState]              Adapter-owned opaque blob.
 */

/**
 * @typedef {Object} ShellState
 * Passed to render hooks.
 * @property {Session} session
 * @property {*} live                         adapter.live() result, cached for this render
 * @property {*} reference                    loaded reference, or null
 * @property {*} pendingApprovalProjection    sandbox-projected new-live, or null
 * @property {boolean} isBusy
 * @property {'popup'|'split'} layout
 */

/**
 * @typedef {Object} Adapter
 *
 * ## Identity
 * @property {string} id                                Stable identifier (namespacing prefix)
 * @property {string} title                             Popup title
 * @property {string} mode                              History filter key
 * @property {'popup'|'split'} layout                   Picks template + UI shape
 * @property {string} [popupClassName]                  Extra CSS class on popup root
 *
 * ## i18n
 * @property {(key: string) => string} i18n
 * @property {(key: string, ...args: any[]) => string} i18nFormat
 *
 * ## Live + persistence
 * @property {() => any | Promise<any>} live            Current authoritative value
 * @property {(newLive: any) => Promise<void>} commit   Adapter writes back to its store; expected atomic
 * @property {(context?: any) => string} sessionScope   Scope key (e.g. 'global', 'character_<avatar>')
 *
 * ## Session storage (adapter-owned)
 * @property {(scope: string) => Promise<SessionMeta[]>} listSessions
 * @property {(scope: string, id: string) => Promise<Session|null>} loadSession
 * @property {(scope: string, session: Session) => Promise<void>} saveSession
 * @property {(scope: string, id: string) => Promise<void>} deleteSession
 * @property {(scope: string) => Promise<void>} [clearObsoleteSessions]   One-shot wipe hook
 *
 * ## Tool catalog + dispatch
 * @property {(session: Session) => ToolDefinition[]} buildToolCatalog
 * @property {(call: Object) => 'editable'|'control'} [classifyToolCall]
 * @property {(call: Object, ctx: {session: Session, live: any}) => Object[] | null | Promise<Object[] | null>} normalizeToolCallToEdit
 * @property {(call: Object, ctx: {session: Session, live: any}, signal: AbortSignal|null) => Promise<{content: string, action?: string, continueRequested?: boolean, finalized?: boolean, finalizeSummary?: string}>} [executeControlToolCall]
 * @property {(registry: Object) => void} [registerCustomOps]
 * @property {(toolName: string) => string} [describeTool]
 *
 * ## LLM prompts
 * @property {(session: Session) => string} buildSystemPrompt
 * @property {(session: Session, userText: string, opts: {reference: any, sourceScope: string, sourceName: string}) => string} buildUserPrompt
 * @property {(execResult: ExecutionResult) => string} [buildAutoContinuePrompt]
 *
 * ## LLM request shaping
 * @property {(settings: any) => {apiPresetName: string, llmPresetName: string}} [getRequestPresetOptions]
 * @property {(session: Session, signal: AbortSignal|null) => Promise<any|null>} [resolveRuntimeWorldInfo]
 * @property {{continue?: string, finalize?: string}} [controlToolNames]
 *
 * ## Reference
 * @property {(session: Session) => {id: string, label: string}[]} [listReferences]
 * @property {(id: string) => Promise<any>} [loadReference]
 *
 * ## UI slots
 * @property {(message: SessionMessage, state: ShellState) => string} renderMessageCard
 * @property {(meta: SessionMeta) => string} renderHistoryItem
 * @property {(state: ShellState) => string} [renderPreviewPane]
 * @property {(state: ShellState) => {start?: string, end?: string}} [renderToolbarSlots]
 * @property {(actionId: string, ctx: {session: Session, root: any, popupId: string}) => Promise<void>|void} [handleAction]
 * @property {(popupClassName: string) => void} [ensureStyles]
 */

export {}; // module marker; this file is JSDoc-only
