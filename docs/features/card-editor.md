# Character Card Editor

The Character Card Editor is Luker's built-in AI-assisted editing tool that lets you modify character card settings and World Info entries using natural language instructions. Every modification made by the AI is presented as a diff comparison for your item-by-item approval before taking effect — ensuring your character card always remains under your control.

## AI Edit Popup

For standard character cards without CardApp, clicking the "Open Editor" button opens an AI conversation panel as a popup. You can describe desired modifications in natural language within the popup, and the AI will understand your intent and execute automatically via tool calls.

### Supported Operations

The AI in the edit popup can perform the following operations:

- **Modify character card fields** — Name, description, personality, scenario, first message, example dialogue, system prompt, jailbreak prompt, creator's notes, etc.
- **Manage World Info entries** — Create, update, delete World Info entries
- **Query World Info** — Search entries by keyword, query by activation conditions, get entry details
- **Set primary World Info** — Change the character card's bound primary World Info book
- **Simulate Prompt** — Preview the actual prompt structure sent to the model under current settings

### Diff Approval

After each AI modification, the system displays a diff comparison of the before-and-after content. You can:

- **Approve individually** — Approve or reject each modification operation separately
- **Batch approve** — Approve or reject all modifications from the same round at once
- **View detailed diff** — Expand to see line-by-line differences, with zoom view support
- **Rollback** — Revert a specific field to a previous version

Only modifications you explicitly approve take effect; rejected modifications are discarded.

### Session Management

- Supports multiple editing sessions — you can create, switch, and delete sessions
- Each character retains up to **24** sessions; the earliest sessions are automatically cleaned up when exceeded
- Session content is persistently saved and won't be lost when the popup is closed and reopened

### Modification History

All modifications made through the AI are recorded in the modification history. You can:

- View the detailed diff of each modification
- Roll back to any historical version
- Delete individual records or clear all history

### World Info Sync

When you import a new character card via replace or update operations, if the old and new character cards are bound to different World Info books, the editor assistant will display a World Info sync popup offering three options:

- **Analyze and update with model** — AI analyzes the differences between old and new World Info books and intelligently merges them
- **Direct replace** — Completely replace the old World Info book with the new one
- **Don't replace** — Keep the existing World Info book unchanged

## CardApp Studio

Studio is the editor assistant's full development environment, designed specifically for character cards that contain [CardApp](/features/cardapp). For character cards with CardApp, clicking "Open Editor" automatically opens Studio instead of the popup.

### Interface Layout

Studio uses a three-panel layout:

- **Left panel** — AI conversation area for describing requirements in natural language
- **Center area** — Live chat interface / CardApp preview
- **Right panel** — CodeMirror 6-based code editor + file management

### Supported Operations

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
- List associated World Info books
- Get World Info entries
- Create, update, delete entries

### Code Editor

The right panel integrates a CodeMirror 6 editor with support for:

- Syntax highlighting (automatic file type detection)
- File switching and management
- Creating new files
- Save and reload

### File Change Approval

AI modifications to files also require your approval. The system displays a diff of file changes, and you can choose to approve or reject.

### Session Management

- Supports multiple editing sessions — you can create, switch, and delete sessions
- Each character retains up to **20** sessions
- Session content is persistently saved in character state

### Version History

Studio records file version history via Git, supporting viewing historical versions and rollback.

## Configuration Options

In the editor assistant's settings panel, you can configure:

- **World Info sync popup** — Whether to enable the World Info sync popup after replacing/updating character cards
- **LLM Preset** — The prompt preset used by the editor assistant (leave empty to use the current preset)
- **API Preset** — The API connection configuration used by the editor assistant (leave empty to use the current configuration)
- **Tool call retry count** — Number of retries when the AI returns invalid tool calls

## Related Pages

- [CardApp](/features/cardapp) — In-card application concept
- [Search Plugin](/features/search-tools) — Search engine configuration and usage
- [State System](/features/state-system) — Character state and chat state
