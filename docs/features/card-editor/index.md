# Character Card Editor Assistant

The Character Card Editor Assistant (CEA) is Luker's built-in AI-assisted editing tool. It lets you modify character card fields, World Info entries, and CardApp code using natural-language instructions. Every modification the AI proposes is presented as a diff comparison for review before taking effect.

Two editing surfaces cover character cards and embedded CardApps:

| Mode | When it applies | Detailed docs |
| --- | --- | --- |
| **Workbench Card Editing** | Character card fields and bound World Info books | [Workbench Card Editing](/features/card-editor/popup) |
| **CardApp Studio** | Character cards with an embedded CardApp | [CardApp Studio](/features/card-editor/studio) |

## Shared Capabilities

- **AI tool-call driven** — Describe what you want in natural language; the AI stages structured edits to fields and files via tool calls
- **Diff approval** — Every change is shown in the **Change list** with before/after diffs; select what to apply or discard
- **Expandable line-by-line diffs** — Field-level differences expand to inspect long text edits line by line
- **Session persistence** — Multiple edit sessions are saved per character; reopening picks up where you left off
- **Change history & undo** — Applied changes are recorded in **Workbench → Change history** (and Git version history inside CardApp Studio) for step-by-step undo

## Entry Points

- **Workbench → AI iteration** (**Character card** / **World book**) — conversational editing with diff cards, live card preview, and rollback inside [Workbench](/features/workbench).
- **Extensions → Character Editor Assistant** — **Open Editor** jumps directly to **Workbench → AI iteration → Character card** for the active character, and **&lt;/&gt; CardApp Studio** launches the three-panel IDE for cards with an embedded CardApp.

![Editor assistant entry and configuration in the extensions panel](/images/card-editor-popup/cea-extensions-panel.png)

## Configuration Options

Configure shared defaults in **Workbench → Settings**, or set extension-level presets under **Extensions → Character Editor Assistant**:

- **Iteration AI prompt preset (params + prompt)** — Prompt preset used by the editor assistant and CardApp Studio; leave empty to follow the shared Workbench setting or the active preset. The actions below the selector import the bundled `plugin-only` example, or open the preset workspace to derive from an existing preset
- **Iteration AI API preset (Connection profile)** — API connection used by the editor assistant and CardApp Studio
- **Tool-call retries on invalid/missing tool call (N)** — Number of retries when the AI returns an invalid tool call
- **Custom System Prompts (advanced)** — Overrides the **Editor iteration prompt** and the **CardApp Studio prompt**

## Modification History

Card and world book edits applied in Workbench appear in **Workbench → Change history** for individual undo. In CardApp Studio, file changes are tracked in version history; see [CardApp Studio](/features/card-editor/studio#version-history-git).

## Related Pages

- [Workbench Card Editing](/features/card-editor/popup) — AI editing flow for character cards and World Info sync
- [CardApp Studio](/features/card-editor/studio) — Full development environment for character cards with CardApp
- [CardApp](/features/cardapp) — In-card application system
- [Search Tools](/features/search-tools) — Web search inside Studio and Workbench AI iteration
