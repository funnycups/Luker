# CardApp Studio

CardApp Studio is the editor assistant's full development environment, designed for character cards that embed a [CardApp](/features/cardapp). It provides a code editor, live preview, AI-assisted development, and version history, making it the recommended workbench for building and debugging CardApps.

::: tip First time using Studio?
See [Build a CardApp from scratch](/features/card-editor/walkthrough/) for a full working loop demonstrated end-to-end on a sample card, including a prompting cheatsheet. This page is the capability reference for Studio; the walkthrough is the hands-on path.
:::

## How to Open

Two paths take you into Studio:

1. **Extensions Panel → Character Card Editor Assistant → "&lt;/&gt; CardApp Studio" button**
2. When the current character contains a CardApp, **"Open Editor" also goes straight to Studio** (instead of the [popup](/features/card-editor/popup))

## Interface Layout

Studio uses a three-panel layout that overlays Luker's main UI:

![Studio overview: AI chat on the left, live preview in the middle, code editor on the right](/images/cardapp-studio/studio-overview.png)

- **Left panel** — AI conversation; describe what you need in natural language, and the AI edits the files
- **Center area** — live chat interface and CardApp preview, where each change can be checked
- **Right panel** — code editor and file list

### Left: AI Chat and Sessions

The left panel hosts the Studio AI assistant. Every change to the CardApp originates here:

![Studio AI chat panel](/images/cardapp-studio/studio-ai-chat.png)

The "Sessions" button at the top expands to show every Studio session under the current character; you can create / switch / delete:

![Studio sessions panel](/images/cardapp-studio/studio-sessions.png)

### Center: Live CardApp Preview

The center area is SillyTavern's own chat UI, with the CardApp rendered live inside it. After the AI changes files and you approve, the preview reloads automatically and you immediately see the result:

![Center panel: the abyss-walker CardApp running live](/images/cardapp-studio/studio-preview.png)

The screenshot above shows the demo character "Abyss Walker"'s CardApp at runtime — the status bar (HP/MP/Gold), the action button area (Explore / Search / Combat / Rest / Descend / Inventory / Undo / Regenerate / Save), and the custom action input — all rendered by the CardApp's HTML/JS.

### Right: Code Editor, File Tree, Git History

The right panel combines three sections:

![Right panel: code editor, file list, version history](/images/cardapp-studio/studio-code-editor.png)

- Top — **Code editor** with automatic syntax highlighting per file type (HTML / JS / CSS / JSON, etc.); save and reload buttons in the upper right
- Middle — **File list** with all CardApp files and their sizes; click to switch the editing target
- Bottom — **Modification history** — version list, each row showing a version identifier, message, time, and a rollback button

## Supported Operations

The AI in Studio has more capabilities than the popup, in the following groups:

**CardApp file operations:**
- List all files
- Read file contents
- Create or overwrite files
- Patch files (find and replace)
- Delete files
- Rename / move files
- Enable or disable the CardApp

**Character card field operations:**
- Read all editable fields
- Update one or more fields

**World Info operations:**
- List visible world books with their scope: character, chat, or global
- Get / create / update / delete / replace entries inside a book
- List, replace, and create world books bound to the current chat

**Regex script operations** — list, create, update, and delete character-level or global regex scripts. Studio AI is the only place a card-level regex script gets created in this workflow.

**Per-character orchestrator override** — read, replace, or clear the orchestrator override stored on the active card. Always character-scoped; never touches the global orchestrator settings.

**Per-character memory-graph override** — read the effective memory-graph configuration, replace node types, or adjust advanced settings. Always character-scoped.

**Lookup** — Studio can look up slash commands, the runtime interface, and the documentation on this site to verify names and usage before generating code.

::: tip CardApp authoring convention
By Luker's CardApp authoring convention, all AI-visible content belongs in the bound world book, not in the character card's main prompt. Studio AI follows this convention by default. See the [Card Developer Guide](/development/card-developers) for details.
:::

## Code Editor Details

Capabilities of the code editor on the right:

- **Syntax highlighting** — Auto-detected from file extension (HTML / JS / CSS / JSON, etc.)
- **Multi-file switching** — Tab-style management of open files
- **New file** / **Save** / **Reload**
- **Manual edits are recorded too** — your direct edits enter version history as well

## File Change Approval

Every AI change to a file requires approval. As in the popup, the interface shows the full changes with a line-by-line comparison, and you can approve them individually or in a batch. Approved changes hit the disk; the rest are discarded.

## Session Management

- Multiple development sessions; create / switch / delete
- Each character keeps up to **20** sessions
- Sessions are stored in character state and survive closing Studio

## Version History {#version-history-git}

Studio records file version history automatically:

- Every approved batch of changes creates a version record
- View the changes in historical versions
- Roll back to any historical version
- Version history is exported with the character card data, so the recipient sees the full development history

::: info Where the data lives
Version records are stored in Luker's extension data and are not written into the card's standard fields. A CardApp depends on Luker's runtime, so it does not run after export to SillyTavern.
:::

## Search Tools Integration

Studio integrates [Search Tools](/features/search-tools), so the AI can look things up online during development and use the results when generating code. It works whenever the search plugin is available.

## Related Pages

- [Editor Assistant Overview](/features/card-editor/) — Shared capabilities and entry points
- [Popup Mode](/features/card-editor/popup) — AI editing for character cards without CardApp
- [CardApp](/features/cardapp) — Character-card-as-app concept
- [Card Developer Guide](/development/card-developers) — CardApp API reference and authoring conventions
