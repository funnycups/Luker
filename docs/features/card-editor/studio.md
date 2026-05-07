# CardApp Studio

CardApp Studio is the editor assistant's full development environment, designed for character cards that embed a [CardApp](/features/cardapp). It provides a CodeMirror 6-based editor, live preview, AI-assisted development, and Git version control — making it the recommended workbench for building and debugging CardApps.

::: tip First time using Studio?
See [Build a CardApp from scratch](/features/card-editor/walkthrough) for a full working loop demonstrated on a light-novel-style Western fantasy survival card, including a prompting cheatsheet. This page is the capability reference for Studio; the walkthrough is the hands-on path.
:::

## How to Open

Two paths take you into Studio:

1. **Extensions Panel → Character Card Editor Assistant → "&lt;/&gt; CardApp Studio" button**
2. When the current character contains a CardApp, **"Open Editor" also goes straight to Studio** (instead of the [popup](/features/card-editor/popup))

## Interface Layout

Studio uses a three-panel layout that overlays Luker's main UI:

![Studio overview: AI chat on the left, live preview in the middle, code editor on the right](/images/cardapp-studio/studio-overview.png)

- **Left panel** — AI conversation; describe needs in natural language and the AI edits files via tool calls
- **Center area** — Live chat interface / CardApp preview; verify changes as you make them
- **Right panel** — CodeMirror 6 code editor + file tree management

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

![Right panel: CodeMirror editor, file list, Git history](/images/cardapp-studio/studio-code-editor.png)

- Top — **Code editor** (CodeMirror 6) with automatic syntax highlighting per file type (HTML / JS / CSS / JSON, etc.); save / reload buttons in the upper right
- Middle — **File list** with all CardApp files and their sizes; click to switch the editing target
- Bottom — **Modification history** — Git commit list, each row showing short commit hash, message, time, and a rollback button

## Supported Operations

The AI in Studio has a richer toolset than the popup:

**CardApp file operations:**
- List all files
- Read file contents
- Create or overwrite files
- Patch files (find and replace)
- Delete files
- Rename / move files

**Character card field operations:**
- Read all editable fields
- Update one or more fields

**World Info operations:**
- List bound World Info books
- Get World Info entries
- Create, update, delete entries

::: tip CardApp authoring convention
By Luker's CardApp authoring convention, all AI-visible content should live in World Info books bound via `extensions.world`, not in the character card's `system_prompt` / `post_history_instructions` fields. Studio AI follows this convention by default. See the [Card Developer Guide](/development/card-developers) for details.
:::

## Code Editor Details

Capabilities of the CodeMirror 6 editor on the right:

- **Syntax highlighting** — Auto-detected from file extension (HTML / JS / CSS / JSON, etc.)
- **Multi-file switching** — Tab-style management of open files
- **New file** / **Save** / **Reload**
- **AI and your edits coexist** — Direct edits you make are also captured in Git version control

## File Change Approval

Every AI change to files requires approval, with the same diff experience as the popup: full file diff, line-by-line side-by-side view, individual / batch approval. Approved changes hit the disk; the rest are discarded.

## Session Management

- Multiple development sessions; create / switch / delete
- Each character retains up to **20** sessions (vs. 24 for the popup)
- Session content is persisted in character state and survives closing Studio

## Version History (Git)

Studio uses Git to record file version history automatically:

- Every approved batch of changes becomes a commit
- View diffs of historical versions
- Roll back to any historical version
- The Git history is exported with the character card data, so the recipient sees the full development history

::: info SillyTavern data compatibility
The Studio Git repository is stored in Luker's extension data area; it doesn't pollute the V2 character card standard fields. When importing back into SillyTavern, only the version history is lost — the CardApp itself still runs.
:::

## Search Tools Integration

Studio integrates the [Search Tools](/features/search-tools) capability — the AI can search the web during development (for API docs, design references, etc.) and apply results directly in the coding context. No extra setup is needed; if the search plugin is available, Studio uses it.

## Related Pages

- [Editor Assistant Overview](/features/card-editor/) — Shared capabilities and entry points
- [Popup Mode](/features/card-editor/popup) — AI editing for character cards without CardApp
- [CardApp](/features/cardapp) — Character-card-as-app concept
- [Card Developer Guide](/development/card-developers) — CardApp API reference and authoring conventions
