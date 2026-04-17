# API Connections

Luker doesn't include AI models itself — it connects to external Large Language Model (LLM) services via APIs to generate responses. This page explains how to configure and manage API connections.

## Supported API Types

Luker supports a wide range of mainstream LLM APIs:

### Chat Completion

| API Provider | Description |
|-------------|-------------|
| **OpenAI** | GPT series models (e.g., GPT-5, etc.) |
| **Anthropic** | Claude series models |
| **Google AI Studio / Vertex AI** | Gemini series models |
| **OpenRouter** | Aggregation service routing to multiple model providers |
| **Custom OpenAI-compatible API** | Any service compatible with the OpenAI API format (e.g., various proxy/relay services) |

### Text Completion

| API Provider | Description |
|-------------|-------------|
| **KoboldAI** | Locally-run open-source models |
| **Ollama** | Local model management and inference tool |
| **llama.cpp / TabbyAPI** | Local inference backends |
| **Text Generation WebUI** | Oobabooga's web interface |

::: info
Chat Completion and Text Completion are two different API modes. Most commercial APIs (OpenAI, Claude, Gemini) use Chat Completion mode; local models typically support both. If you're unsure, Chat Completion is the more common choice.
:::

## Connection Manager

Luker provides a **Connection Manager** to manage multiple API connection profiles.

### Creating a Connection Profile

1. Open the settings panel and find the Connection Manager
2. Click "New Profile"
3. Enter a profile name (e.g., "Claude Sonnet 4.5," "GPT-5")
4. Select the API type and fill in the connection parameters
5. Save the profile

### Switching Connections

Select a different profile from the Connection Manager dropdown to switch instantly. Switching connections does not affect your current chat completion preset.

### Managing Multiple Connections

You can create any number of connection profiles, for example:

- A low-cost model for everyday conversation
- A flagship model for high-quality creative writing
- A profile for local models

The Connection Manager lets you switch between them quickly without re-entering API addresses and keys each time.

## API Key Configuration

### Obtaining API Keys

Each API provider has its own way to obtain keys:

- **OpenAI**: Create an API Key at [platform.openai.com](https://platform.openai.com)
- **Anthropic**: Create an API Key at [console.anthropic.com](https://console.anthropic.com)
- **Google**: Get an API Key at [aistudio.google.com](https://aistudio.google.com)
- **OpenRouter**: Register and get a Key at [openrouter.ai](https://openrouter.ai)

### Entering Keys

Enter the corresponding API key in the connection profile. Keys are securely stored on Luker's server side and are never exposed on the frontend.

::: tip
If you're using a self-hosted Luker instance, API keys are stored on your own server. If you're using someone else's Luker instance, be mindful of key security.
:::

## Model Selection

After configuring an API connection, you need to select the specific model to use. Luker dynamically loads the list of available models based on the API type.

For APIs like Claude and Gemini, Luker supports **dynamic model lists** — automatically fetching the latest available models from the API without manual updates. You can also customize the model list for each API source. See [Other Improvements](/improvements/other) for details.

## Proxy Settings

If you need to access APIs through a reverse proxy, you can configure it in the connection profile:

- **Proxy address**: The relay service URL
- **Proxy password**: The relay service authentication password (if required)

Proxy settings are part of the connection profile — different profiles can use different proxies.

## Relationship with Preset Decoupling

In Luker, API connections and chat completion presets are **completely independent** concepts:

- **Connection profiles** manage "which API, which model, and through what address"
- **Chat completion presets** manage "which prompts and which sampling parameters"

You can freely combine them. For example:

- Use the same Claude API connection with different presets to switch writing styles
- Use the same carefully tuned preset to compare results between OpenAI and Claude

This decoupled design lets you optimize connections and presets independently without interference.

See [Preset System](/basics/presets) and [Preset Decoupling](/improvements/preset-decoupling) for details.

## Slash Commands

Luker's Connection Manager provides slash commands for power users:

| Command | Description |
|---------|-------------|
| `/profile [name]` | Switch to the specified connection profile, or view the current profile name |
| `/profile-list` | List all connection profiles |
| `/profile-create <name>` | Create a new profile with current settings |
| `/profile-update` | Update the currently selected profile |

## Request Inspector

Luker includes a built-in Request Inspector that lets you view detailed information about each generation request, including the complete request content sent to the API and the returned response. This is very useful for debugging connection issues or optimizing prompts.

## Next Steps

- Learn how the [Preset System](/basics/presets) controls AI response behavior
- Learn the basics of [Character Cards](/basics/character-cards)
- Learn the basics of [Chat Management](/basics/chat-management)
