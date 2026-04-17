# Character Card Editor

The Character Card Editor is Luker's built-in AI-assisted editing tool that lets you modify character card settings and World Info entries using natural language instructions. Every modification made by the AI is presented as a diff comparison for you to approve item by item before taking effect — ensuring the character card always remains under your control.

## Two Editing Methods

### Standard Edit Popup

In the character card editing interface, you can directly edit various fields of the character card (description, personality, scenario, etc.). This is the most basic editing method, suitable for quick manual modifications.

Editable fields include:

- **Character Name** — The character's display name
- **Character Description** — Detailed description of the character's appearance, background, identity, etc.
- **Personality Summary** — Brief summary of character personality traits
- **Scenario** — The scene and background where the story takes place
- **First Message** — The character's opening message
- **Example Dialogue** — Examples showcasing the character's speaking style
- **System Prompt** — Character card-level system instructions
- **Jailbreak Prompt** — Character card-level override instructions
- **Creator's Notes** — Usage instructions for other users
- **Alternate Greetings** — Multiple optional opening messages

### Studio Panel

Studio is the core feature of the Character Card Editor — an AI conversation panel independent from the main chat area, dedicated to character card editing. You can describe desired modifications in natural language, just like chatting with AI, and the AI will understand your intent and execute automatically.

**Typical workflow:**

1. Open the Studio panel in the character card editing interface
2. Describe your desired modifications in natural language, for example:
   - "Make the character's personality more introverted"
   - "Add a World Info entry about the character's hometown"
   - "Change the first message to meeting in a cafe on a rainy day"
   - "Add a pet cat to the character's settings"
3. AI parses your instructions and executes modifications
4. The system displays a before-and-after diff comparison, waiting for your approval
5. Modifications take effect after confirmation

**Session Management:**

- Studio supports multiple editing sessions — you can create, switch, and delete sessions
- Each character retains up to **24** sessions; the earliest sessions are automatically cleaned up when exceeded
- Session content is persistently saved and won't be lost when the panel is closed and reopened

## Studio's Editing Capabilities

Studio AI can edit character cards and World Info through the following 7 operations:

| Operation | Description |
|-----------|-------------|
| Modify Character Settings | Update character card text fields: name, description, personality, scenario, first message, example dialogue, system prompt, jailbreak prompt, creator's notes, alternate greetings |
| Set Primary World Info | Set or clear the character card's bound primary World Info; can auto-create non-existent World Info |
| Create/Update World Info Entry | Create new World Info entries or update existing entries' content, keywords, injection position, and other attributes |
| Delete World Info Entry | Delete specified World Info entries |
| List World Info Entries | View an overview of all entries in the character card's associated World Info |
| Query World Info Entries | Query World Info entries by conditions, getting details of matching entries |
| Simulate Prompt Assembly | Simulate prompt assembly results under the current character card configuration, helping AI understand the actual effect of each field in the final prompt |

::: tip Simulate Prompt Assembly
"Simulate Prompt Assembly" is a particularly useful feature. AI can use it to see the actual position and effect of each character card field in the final prompt sent to the LLM, enabling more precise editing suggestions. For example, AI can discover that a certain setting is placed in a suboptimal position and suggest adjustments.
:::

## Modification Approval

After each AI modification, the system generates a line-level diff comparison view showing clearly what content was added, deleted, or modified.

- **Item-by-item review**: You can review each modification operation one by one
- **Approve or reject**: Independently decide whether to accept each modification
- Rejected modifications are reverted without affecting character card data

This mechanism ensures all AI modifications are under your control, preventing unexpected data changes.

## Operation History and Rollback

Each successfully executed operation is recorded in the operation log, containing the following information:

- Unique operation ID
- Operation type (e.g., modify character field, create/update/delete World Info entry, set primary World Info, etc.)
- Complete operation parameters
- Source marker (AI tool call or manual operation)
- Timestamp

The log limit is **120 entries**; the earliest records are automatically trimmed when exceeded.

You can perform rollback on any record in the operation history, restoring the character card or World Info to the state before that operation.

**Rollback limitations:**

- Rollback operations themselves are also recorded as log entries
- Rolling back a rollback record is not supported (i.e., you cannot "undo a rollback")
- You can also delete individual history records or clear all history

## Integration with Search Tools

The Character Card Editor automatically detects whether the [Search Tools](/features/search-tools) plugin is available. If the search plugin is enabled, Studio AI gains additional web search and page access capabilities — you can have AI search for relevant materials to assist with character card editing, such as "Search for medieval knight equipment, then update the character description."

This means AI can, while editing character cards:

- Search the web for character-related reference materials
- Access web pages to extract detailed information
- Refine character settings based on search results

For example, you can tell AI "Search for Victorian-era clothing styles, then update the character's appearance description," and AI will first search for relevant materials, then modify the character card accordingly.

If the search plugin is unavailable, the editor works normally but without web search capabilities.

## World Info Sync

When you replace or update a character card, the associated World Info may also need corresponding updates. The Character Card Editor provides an intelligent World Info sync mechanism:

- The system automatically detects World Info changes when a character card is replaced
- The sync process can be configured with independent LLM presets and API presets
- Controlled by the `replaceLorebookSyncEnabled` configuration option

::: tip Configuration Recommendation
If you frequently import updated versions of character cards from external sources, it's recommended to enable World Info sync to avoid inconsistencies between World Info data and character card versions.
:::

## Related Pages

- [Search Tools](/features/search-tools) — Search engine configuration and usage
- [CardApp](/features/cardapp) — Character card application concept
