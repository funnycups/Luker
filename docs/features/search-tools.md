# Search Tools

Search Tools provides AI characters with web search capabilities, allowing characters to retrieve real-time information during conversations and inject search results into the context. The search plugin supports multiple search engine backends and provides working modes to accommodate different use cases.

## Working Modes

```d2
direction: right

TOOL: "Tool mode" {
  T_USER: "User asks"
  T_LLM: "Creative LLM"
  T_DECIDE: "LLM decides:\nsearch needed?" {
    shape: diamond
  }
  T_TOOL: "Calls luker_web_search\n/ luker_web_visit" {
    style.fill: "#e1f5ff"
  }
  T_RESULT: "Result returned as tool-call output\ninjected into context"
  T_FINAL: "LLM produces final reply"

  T_USER -> T_LLM -> T_DECIDE
  T_DECIDE -> T_TOOL: "yes"
  T_TOOL -> T_RESULT
  T_RESULT -> T_LLM
  T_DECIDE -> T_FINAL: "no"
}

AGENT: "Pre-request agent mode" {
  A_USER: "User asks"
  A_AGENT: "Search agent\nindependent LLM preset"
  A_DECIDE: "Analyze conversation:\nsearch needed?" {
    shape: diamond
  }
  A_SEARCH: "Run search\nmulti-round if needed"
  A_WRITE: "Write results to World Info entries" {
    style.fill: "#fff3e0"
  }
  A_LLM: "Creative LLM"
  A_FINAL: "LLM produces final reply\nWorld Info entries injected as references"

  A_USER -> A_AGENT -> A_DECIDE
  A_DECIDE -> A_SEARCH: "yes"
  A_SEARCH -> A_WRITE -> A_LLM -> A_FINAL
  A_DECIDE -> A_LLM: "no"
}
```

### Tool Mode

Search functionality is registered as a callable tool for the creative LLM in the [Function Call Runtime](/improvements/function-call-runtime). When the AI determines it needs to search for information, it initiates a web search or page visit tool call and receives the results directly in context.

### Pre-request Agent Mode

Before the creative LLM generates a response, an independent search Agent runs automatically. The Agent analyzes the current conversation content, determines whether a search is needed, and writes search results into World Info entries.

- Enabled via **Run pre-request search agent**
- Uses its own prompt preset and API connection, separate from the creative model
- Runs a tool-call loop until it replies with plain text and no tool calls
- Reads back, updates, and deletes the entries it created so existing notes are revised cleanly
- Writes search results as World Info entries for the creative LLM to read during generation
- Streams live progress into the shared **Run panel** dock (opened automatically by default, or toggled in the dock menu with **Open automatically on run**)

![Pre-request search agent run in the run panel](/images/search-tools/run-panel.png)

::: tip Choosing Between Modes
**Tool Mode** fits scenarios where the model decides on its own when to search during conversation—for example, when a user asks about recent news.

**Pre-request Agent Mode** searches automatically before AI generation, keeping the search pass separate from the main conversation.
:::

## Settings Panel

Search Tools configuration lives under **Extensions → Search Tools**:

![Search Tools settings panel](/images/search-tools/search-tools-settings.png)

The top toggles map to the two modes (**Expose tools to main model** = Tool Mode, **Run pre-request search agent** = Pre-request Agent Mode); they can be enabled independently or together. Below them are engine selection, agent presets, and World Info entry injection parameters. Click **Show search run panel** to open the shared Run panel dock on demand.

## Supported Search Engines

| Search Engine | Description | Configuration Requirements |
|---------------|-------------|----------------------------|
| **DuckDuckGo** | Default search engine, no API key required | Works out of the box |
| **SearXNG** | Self-hosted meta search engine | Requires self-hosted instance URL |
| **Brave Search** | Search API provided by Brave | Requires API key |
| **Tavily** | LLM-oriented search API | Requires API key |
| **Exa** | Neural / semantic search API | Requires API key |
| **Serper** | Google results via serper.dev | Requires API key |
| **SerpApi** | Google results via SerpApi | Requires API key |
| **Z.AI** | Z.AI web search | Requires API key |
| **DeepSeek** | DeepSeek native web search | Requires DeepSeek API key |

Safe search is available for DuckDuckGo, SearXNG, Brave Search, Tavily, Exa, and SerpApi.

## World Info Entry Management

In Pre-request Agent Mode, search results are created as World Info entries. You can configure **Injection position**, **Injection depth**, **Injection role**, and **Injection order** directly in the Search Tools panel, and inspect or clear stored entries via **Manage stored search entries**.

## Use from other features

Search is also available to Workbench AI iteration (character card and world book editing), CardApp Studio, and the Character Editor Assistant popup, allowing the editing AI to look up references online. The developer interface is documented in the [Extension API](/development/extension-api/).

## Result Reuse

Search Tools reuses the previous search Agent result when all of the following match:

1. The current chat matches the previous snapshot's chat
2. The last user message matches the previous snapshot
3. The current generation type supports reuse (such as regenerate or continue)

When results are reused, the Run panel marks the run as reused.

## Impact of Message Operations

The plugin keeps the shared lorebook aligned with stored search results as the chat changes:

- **Deleting a message** — search results for the deleted turn and every later turn are dropped
- **Swiping a message** — search results for the swiped turn are dropped
- **Editing a message** — stored results stay; editing the turn a search ran for triggers a fresh search on the next generation

## Configuration Reference

| Setting | Description |
|---------|-------------|
| **Expose tools to main model** | Enable Tool Mode, allowing the model to call web search during conversation |
| **Run pre-request search agent** | Enable Pre-request Agent Mode, searching automatically before generation |
| **Search provider** | Select the search engine |
| **Default max search results** | Number of results returned per search |
| **Default page excerpt max chars** | Maximum text length extracted when visiting web pages (`0` = full extract) |
| **Safe Search** | Safety filtering level for search results |
| **Agent API preset** | API connection preset for the pre-request Agent (empty uses main connection) |
| **Agent preset** | Generation preset for the pre-request Agent (empty uses main preset). The help button beside the dropdown explains the expected preset type |

::: info Related Pages
- [Workbench](/features/workbench) — AI editing with web search access
- [Character Card Editor Assistant](/features/card-editor/) — editor assistant overview
- [CardApp Studio](/features/card-editor/studio) — web search inside Studio
- [Run Panel API](/development/extension-api/run-panel) — shared Run Dock developer reference
:::
