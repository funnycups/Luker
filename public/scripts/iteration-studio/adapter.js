/**
 * IterationStudio — ProfileAdapter contract.
 *
 * The IterationStudio shell is an extension-agnostic AI iteration workbench:
 * a popup where the user converses with an LLM that uses tool calls to edit
 * a single typed profile, with diff preview, approve/reject, auto-continue
 * (`continueRequested:true` from the tool call), and apply-to-scope (global
 * settings vs character override).
 *
 * The shell is in this directory (`public/scripts/iteration-studio/`).
 * Per-extension behavior — what the profile looks like, which tools edit
 * it, how it gets persisted — is supplied by a ProfileAdapter object.
 *
 * This file is JSDoc-only and exports nothing at runtime. It exists so the
 * adapter contract has one canonical home that authors of new adapters can
 * read end-to-end.
 *
 * Two reference implementations live in-tree:
 *   - public/scripts/extensions/orchestrator/{spec,agenda,loop}-adapter.js
 *   - public/scripts/extensions/memory-graph/schema-adapter.js
 */

/**
 * @typedef {Object} ToolDefinition
 * OpenAI-style function tool definition that the LLM can call.
 * @property {'function'} type
 * @property {Object} function
 * @property {string} function.name           Stable tool identifier (e.g. 'mg_schema_set_node_type')
 * @property {string} function.description    Shown to the LLM as the tool's purpose
 * @property {Object} function.parameters     JSON Schema for arguments
 */

/**
 * @typedef {Object} Simulation
 * @property {boolean} ok
 * @property {string} summary
 * @property {string} [detail]
 */

/**
 * @typedef {Object} ToolResult
 * @property {string} tool_call_id
 * @property {string} content   Serialized JSON string returned to the LLM as the tool result.
 */

/**
 * @typedef {Object} ExecutionResult
 * Uniform result shape returned by adapter.executeEditableToolCall (composed
 * by the shell into the per-turn ExecutionResult). The shell enriches with
 * continueRequested / finalized / finalizeSummary from CONTROL tools that
 * it owns (continue / finalize / simulate).
 *
 * @property {string[]} actions             Human-readable per-call summaries; concatenated across all calls in a turn.
 * @property {Simulation[]} simulations     Outputs from simulate tool calls; produced by shell or adapter (if adapter overrides simulate).
 * @property {ToolResult[]} toolResults     One entry per call (editable + control); shell composes this.
 * @property {boolean} finalized            True if the assistant called the finalize tool this turn.
 * @property {string} finalizeSummary       Final summary text from the finalize tool, if any.
 * @property {boolean} continueRequested    True if the assistant called the continue tool this turn.
 * @property {boolean} changed              True if any editable call mutated the working profile.
 */

/**
 * @typedef {Object} HistoryState
 * @property {number} version
 * @property {Session[]} sessions   Sorted by updatedAt asc, capped at adapter-defined limit.
 */

/**
 * @typedef {Object} Session
 * Generic session shape used by the shell. Fields under `workingProfile` /
 * `baseWorkingProfile` are adapter-typed; everything else is shell-managed.
 *
 * @property {string} id                            'session_<unix-ms>'
 * @property {string} mode                          adapter.mode
 * @property {string} chatKey                       Reserved for chat scoping; adapter may ignore.
 * @property {'global'|'character'} sourceScope
 * @property {string} sourceAvatar                  '' for global scope
 * @property {string} sourceName                    Human label, e.g. character name.
 * @property {number} revision                      Increments on each successful editable tool call.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {*} workingProfile                     Adapter-typed; the artifact being edited.
 * @property {*} baseWorkingProfile                 Pristine clone for diffing.
 * @property {SessionMessage[]} messages            Full transcript with embedded tool turns.
 * @property {Simulation|null} lastSimulation       Most recent simulate result.
 * @property {PendingApproval|null} pendingApproval Set when assistant proposed editable tools awaiting user click.
 */

/**
 * @typedef {Object} SessionMessage
 * Persistent transcript message. Used both for plain user/assistant text and
 * for assistant turns that include tool calls.
 *
 * @property {string} id
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {boolean} [auto]                       True for shell-initiated auto-continue turns.
 * @property {number} at                            Unix ms.
 *
 * Tool-turn-only fields:
 * @property {Object[]} [tool_calls]                Approval-required calls (subset of LLM output).
 * @property {Object[]} [pendingToolCalls]          Mirror of tool_calls when status==='pending'.
 * @property {Object[]} [executionToolCalls]        ALL calls (editable + control) for execution.
 * @property {ToolResult[]} [tool_results]          Filled when toolState === 'completed'|'rejected'.
 * @property {string} [toolSummary]                 Friendly summary, e.g. "已执行 2 项操作。"
 * @property {'pending'|'completed'|'rejected'} [toolState]
 * @property {*} [profileSnapshotBefore]            workingProfile snapshot pre-execution.
 * @property {*} [profileSnapshotAfter]             workingProfile snapshot post-execution.
 * @property {Object} [profileDelta]                jsondiffpatch delta from before -> after.
 * @property {Object} [reverseProfileDelta]         jsondiffpatch delta from after -> before (for rollback).
 * @property {Simulation|null} [lastSimulationAfter]
 */

/**
 * @typedef {Object} PendingApproval
 * @property {string} messageId
 * @property {string} assistantText
 * @property {Object[]} toolCalls           Approval-required calls.
 * @property {Object[]} executionToolCalls  All calls including control flow.
 * @property {number} createdAt
 */

/**
 * @typedef {Object} ProfileAdapter
 * The contract every adapter must satisfy. The shell calls these methods at
 * specific points in the popup lifecycle. Adapters are typically built via
 * a small factory function (`createXxxAdapter(deps)`) that closes over the
 * extension's own helpers.
 *
 * ## Identity
 * @property {string} id                            Unique stable identifier (e.g. 'orch_spec', 'mg_schema'). Used as namespace prefix.
 * @property {string} title                         Localized popup title.
 * @property {string} mode                          History filter key — one adapter, one mode. Re-used as Session.mode.
 * @property {string} [popupClassName]              Extra class on popup root for adapter-specific CSS hooks.
 *
 * ## i18n (adapter-owned, since each extension has its own locale tables)
 * @property {(key: string) => string} i18n
 * @property {(key: string, ...args: any[]) => string} i18nFormat
 *
 * ## Session / profile lifecycle
 * @property {(context: any, settings: any) => any} getInitialProfile
 *      Build a fresh workingProfile from current global/character state.
 *      Called when creating a new session OR resetting the current one.
 *
 * @property {(workingProfile: any) => any} cloneWorkingProfile
 *      Deep-clone + sanitize. Must be idempotent (safe to call on output of
 *      previous clone). Called for snapshots and for jsondiffpatch input.
 *
 * @property {(settings: any, session: Session) => any} getGlobalBaselineProfile
 *      Returns the *currently persisted* profile from settings (NOT
 *      session.workingProfile). Used by buildUserPrompt to show the LLM
 *      what's saved vs what's been edited in the session.
 *
 * ## Persistence (adapter declares the storage path; shell reads/writes via these)
 * @property {(context: any, scope: 'global'|'character', avatar: string) => Promise<HistoryState>} loadHistoryState
 * @property {(context: any, state: HistoryState, scope: 'global'|'character', avatar: string) => Promise<void>} persistHistoryState
 * @property {(context: any) => 'global'|'character'} getDefaultScope
 *      Decides which scope to load history from when the popup opens.
 *      Conventional rule: 'character' iff there's an active character.
 *
 * ## LLM prompts
 * @property {(settings: any, session: Session) => string} buildSystemPrompt
 *      Adapter-specific contract: profile shape, tool semantics, invariants.
 *      The shell adds nothing on top — adapters control the entire system msg.
 *
 * @property {(settings: any, session: Session, userText: string, opts: {
 *     globalProfile?: any,
 *     sourceScope?: string,
 *     sourceName?: string,
 * }) => string} buildUserPrompt
 *      Stitches: source scope, baseline profile YAML, working profile YAML,
 *      conversation history excerpt, latest simulation, user request.
 *
 * @property {(executionResult: ExecutionResult) => string} [buildAutoContinuePrompt]
 *      Shell provides a generic default; adapters can override.
 *
 * ## Tools
 * @property {(session: Session) => ToolDefinition[]} buildEditableToolSet
 *      The mode-specific editable tools ONLY. The shell injects continue /
 *      finalize / simulate control tools automatically — do not return them
 *      from this method.
 *
 * @property {(toolName: string) => string} [describeTool]
 *      Optional friendly label for pendingApproval summary lines. Default:
 *      uses toolName as-is.
 *
 * ## Tool execution (adapter dispatches editable tools; shell dispatches control flow)
 * @property {(context: any, session: Session, call: any, signal: AbortSignal | null) => Promise<{
 *     content: string,
 *     action: string,
 *     changed: boolean,
 * }>} executeEditableToolCall
 *      Called once per editable tool call. Must mutate session.workingProfile
 *      in place if changed. `content` is what the LLM sees as tool_result.
 *      `action` is the human-readable line, e.g. "Stage 2 updated.".
 *
 * @property {(context: any, session: Session, call: any, signal: AbortSignal | null) => Promise<Simulation>} [executeSimulateCall]
 *      Optional override of the simulate tool. Default: returns a stub
 *      "no simulation available" Simulation object.
 *
 * ## LLM request shaping (shell builds prompts; adapter declares which model + world info)
 * @property {(settings: any) => { apiPresetName: string, llmPresetName: string }} getRequestPresetOptions
 *      Returns the connection profile + LLM preset names to use for this
 *      adapter's LLM calls. Default: `{apiPresetName: '', llmPresetName: ''}`
 *      (means "use whatever's currently active").
 *
 * @property {(context: any, settings: any, session: Session, abortSignal: AbortSignal | null) => Promise<any|null>} [resolveRuntimeWorldInfo]
 *      Optional. Returns a runtime world-info snapshot for the LLM call
 *      (typically resolved via the shared world-info plumbing). Default:
 *      returns null (no world info injected).
 *
 * @property {{ continue?: string, finalize?: string }} [controlToolNames]
 *      Override the names of the shell-injected control tools if your
 *      adapter needs specific names (e.g. for prompt backward compatibility).
 *      Defaults: `{continue: 'iter_continue', finalize: 'iter_finalize'}`.
 *
 * ## Render (right-side preview + per-message diff)
 * @property {(session: Session, opts: {
 *     profileOverride?: any,
 *     previewPending?: boolean,
 * }) => string} renderWorkingProfile
 *      Right-side panel preview HTML. Most adapters call escapeHtml on a
 *      pretty-printed YAML/JSON of session.workingProfile (or override).
 *
 * @property {(session: Session, message: SessionMessage, popupId: string) => string} [renderMessageDiff]
 *      Optional full override of the per-message diff renderer. Default: shell
 *      renders `renderProfileDeltaHtml(adapter, message.profileDelta, ...)`
 *      which uses jsondiffpatch + `renderObjectDiffHtml` to produce structured
 *      "path → before/after" cards. Override only when you need radical
 *      layout changes; for per-leaf tweaks prefer the `renderTextDiff` /
 *      `formatDiffPathLabel` hooks below.
 *
 * @property {(beforeText: string, afterText: string, path: string) => string} [renderTextDiff]
 *      Optional inline text-diff renderer for long string leaves. Receives
 *      raw before/after strings + the JSON path that changed; returns HTML
 *      that replaces the default side-by-side `<pre>` columns for that
 *      single path. The shell threads this directly into
 *      `renderObjectDiffHtml`'s `renderTextDiff` parameter. Adapters with
 *      short-string profiles (e.g. memory-graph schema) can omit this.
 *
 * @property {(path: string, item: object) => string} [formatDiffPathLabel]
 *      Optional path-label formatter. Receives the JSON path string + the
 *      underlying diff item; returns a friendlier label (e.g.
 *      `presets.critic.systemPrompt` → `Preset 'critic' / System Prompt`).
 *      Defaults to the raw path.
 *
 * @property {(item: {path: string, beforeValue: any, afterValue: any, beforePayload: {text: string, missing: boolean}, afterPayload: {text: string, missing: boolean}}) => (string | null)} [renderDiffItem]
 *      Optional full-card renderer for a single diff entry. Receives the
 *      JSON path + before/after values + the default text payloads; returns
 *      either custom HTML (for that one item's body, excluding the path
 *      header which the shell still renders) or `null` to fall back to the
 *      default before/after grid. Use this when the default "two `<pre>`
 *      columns" rendering loses fidelity — e.g. when an entire sub-object
 *      gets replaced and you'd rather show a per-field mini-diff.
 *
 * ## Adapter-managed actions (apply, save, publish, … — shell doesn't assume)
 * @property {(actionId: string, ctx: { session: Session, context: any, settings: any, root: any, popupId: string, popupSelector: string }) => Promise<void> | void} [handleAction]
 *      Optional. Receives any click on an element marked with
 *      `data-iter-custom-action="<id>"` inside the popup. The shell delegates
 *      such clicks here so adapters can render their own action buttons
 *      inside `renderWorkingProfile` output (or anywhere else in their
 *      adapter-owned slot) without having to bind jQuery handlers
 *      themselves — the popup re-renders mid-session and bare bindings
 *      would die.
 *
 *      Studios that don't need to persist anything (purely exploratory,
 *      ephemeral) can omit this entirely and emit no action buttons. The
 *      shell never assumes "apply" is meaningful — the conventional
 *      Luker pattern of `[Apply to Global] [Apply to Character]` is just
 *      one example, implemented by orchestrator + memory-graph adapters
 *      because that's what those domains want.
 *
 * ## Style injection (one-shot when popup opens)
 * @property {(popupClassName: string) => void} [ensureStyles]
 *      Inject adapter-specific CSS once. Default: no-op (relies on shared
 *      luker-studio.css from public/css/).
 */

export {}; // module marker; this file is JSDoc-only
