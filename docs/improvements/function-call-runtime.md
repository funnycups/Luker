# Function Call Runtime

Luker has a built-in unified Function Calling runtime that enables AI characters to perform structured operations — searching information, managing memory, manipulating state — rather than just generating text. Regardless of whether the underlying model natively supports tool calls, Luker provides a consistent calling experience.

## Unified Function Calling Framework

The Function Call Runtime provides a unified framework for managing tool registration, invocation, and result handling. The core design goals are:

- **Model-agnostic** — The same set of tool definitions can seamlessly switch between different LLM providers
- **Protocol-transparent** — Upper-layer tools don't need to care whether the underlying protocol uses native tool calls or text-based protocols
- **Streaming-compatible** — Supports tool call parsing and normalization in streaming responses

## Native Mode

When the connected model natively supports Function Calling (such as OpenAI, Claude, Gemini), Luker uses the model's native tool call format. The runtime will:

1. Convert registered tools to the schema format required by the model
2. Attach tool definitions to the request
3. Parse the tool call structure returned by the model
4. Execute the corresponding tool functions
5. Inject execution results into the context and continue the conversation

The advantage of native mode is leveraging the model's specifically trained tool calling capabilities, resulting in more standardized call formats and more accurate parameter parsing.

## Plain-Text Mode

For models that don't support native Function Calling, Luker provides a plain-text protocol as a fallback. The runtime automatically injects tool usage instructions into the System Prompt, guiding the model to output tool call requests in a specific text format.

The plain-text mode workflow:

1. Describe available tools and their parameter formats in the System Prompt
2. The model outputs tool calls using agreed-upon text markers in its response
3. The runtime parses tool call markers from the text
4. Executes tools and injects results into the context
5. Continues generating subsequent responses

::: tip Use Cases
Plain-text mode is suitable for locally deployed open-source models, API providers that don't support tool calls, or scenarios requiring more flexible tool call formats. While less accurate than native mode, it greatly expands the applicability of function calling.
:::

## Multi-Tool Call Support

The runtime supports calling multiple tools in a single generation (multi-tool / parallel tool calls). When the model requests multiple tool calls in a single response, the runtime will:

- Execute all requested tools sequentially or in parallel
- Collect execution results from all tools
- Batch inject results into the context
- Trigger subsequent generation

This is especially important for scenarios that need to query multiple information sources simultaneously, such as searching the web and querying memory at the same time.

## Streaming Tool Call Normalization

In streaming response scenarios, tool call data may be scattered across multiple data chunks. The runtime automatically reassembles scattered tool call fragments into complete call structures, ensuring that regardless of whether the response is streaming or non-streaming, upper-layer logic receives consistent tool call data.

## Configurable Error Handling

When tool execution fails, the runtime formats the error information and injects it into the context, letting the model know the tool call failed and allowing it to choose to:

- Retry with different parameters
- Try other tools
- Reply to the user directly based on available information

Error information includes structured data such as tool name and failure reason, helping the model make reasonable follow-up decisions.

## Independent Toggle in Connection Manager

Function calling can be independently enabled or disabled at the connection level. Different connection configurations can have different function calling settings, for example:

- Primary connection with full function calling enabled
- Backup connection with function calling disabled to save tokens
- Specific connections with only certain tools enabled

This works in coordination with the [Preset Decoupling](/improvements/preset-decoupling) mechanism — the function calling toggle is part of the connection configuration, and switching presets won't affect it.

## Built-in Tools

The search plugin registers global tools: web search (supporting DuckDuckGo, SearXNG, Brave Search, and other search engines) and web access. Other modules (Editing Assistant, Orchestrator, Preset Assistant) use the tool calling mechanism in their own independent contexts, not through the global tool registry.

::: info Extension Tools
Third-party extensions can register custom tools via `context.registerFunctionTool()` (provided by the `ToolManager` in the core). Tool definitions follow a unified schema format and automatically adapt to both native mode and plain-text mode after registration. See the [Extension API — Tool Registration](/development/extension-api/generation#tool-registration) documentation for details.
:::

## Under the Hood

For developers curious about the internal implementation, the function calling system is composed of three core modules:

| Module | File | Responsibility |
|--------|------|---------------|
| **ToolManager** | `tool-calling.js` | Global tool registry, tool schema conversion, streaming tool call fragment reassembly, tool execution orchestration, and result injection |
| **Function Call Runtime** | `function-call-runtime.js` | Plain-text mode support — building tool protocol messages for System Prompt (`buildPlainTextToolProtocolMessage`), extracting function calls from text responses (`extractAllFunctionCallsFromText` / `extractToolCallsFromTextResponse`), and merging addendum text into prompt messages (`mergeUserAddendumIntoPromptMessages` / `mergeSystemAddendumIntoPromptMessages`) |
| **Request Engine** | `openai.js` (`sendOpenAIRequest`) | The core LLM request function that handles preset resolution, connection override, and dispatching requests to the appropriate API backend |

In **native mode**, the flow is: `ToolManager` converts registered tools to the model's schema → `sendOpenAIRequest` attaches them to the API request → model returns structured tool calls → `ToolManager` parses, executes, and injects results.

In **plain-text mode**, the flow adds an extra layer: `function-call-runtime.js` injects tool descriptions into the System Prompt → model outputs text-formatted tool calls → `function-call-runtime.js` parses the text → `ToolManager` executes and injects results.

Plugins that need to make their own LLM requests with tool calling use `sendOpenAIRequest` directly with `tools` and `toolChoice` parameters — this is separate from the global tool registry. See the [Extension API — Sending LLM Requests](/development/extension-api/generation#sending-llm-requests) documentation.

## Related Pages

- [Improvements Overview](/improvements/overview) — Overview of all technical improvements
- [Preset Decoupling](/improvements/preset-decoupling) — The relationship between function calling toggles and connection configurations
- [Extension API](/development/extension-api/) — Plugin development guide including tool registration and LLM request APIs
