# Walkthrough: Isekai Survival Log

This page uses one complete survival card to show how a single brief gets [CardApp Studio](/features/card-editor/studio) to generate the interface, world book and opening message, then how a few follow-up requests refine it. You describe the result throughout.

## What you get

The result is a single-character immersive roleplay card called "Isekai Survival Log". After you send the first message, you see this:

![Final result screenshot](/images/walkthrough/isekai/step-08-end-to-end.png)

- A top status bar showing day, stamina, hunger and mood
- The protagonist arrives in an unfamiliar forest in a Western low-magic isekai setting; the AI plays the environment and narrator
- A world book bound to the card, with the state record, worldview conventions, and a few NPC settings
- Immersive button labels (Halt / Rewrite / Old Volume / New Chapter / Close Volume) covering the common conversation controls

The whole process only requires describing what you want in natural language. **The AI handles the interface, world book entries, state variables, and opening message, and links everything to the card.**

## Prerequisites

- A working Luker instance
- A configured LLM API. Claude, GPT-5, and other models that support tool calling are recommended
- (For the advanced section) A working Stable Diffusion / ComfyUI backend

## 1. Create an empty card and open Studio

Open the right-side character panel, click "New Character" and enter a name (this guide uses "Isekai Survival Log"). Studio AI generates the description, first message and world info binding.

Next, open "Extensions" → expand "Character Editor Assistant" → click **"&lt;/&gt; CardApp Studio"**:

![Studio entry location](/images/walkthrough/isekai/step-01-studio-entry.png)

Studio is the three-panel overlay on top of the main UI: AI chat on the left, live preview in the middle, code editor on the right. The new card hasn't enabled CardApp yet, and Studio asks whether to enable it.

![Studio initial empty state](/images/walkthrough/isekai/step-02-studio-empty.png)

::: tip Reading focus
The right panel refreshes as the AI works. Watch the **left chat** and the **center preview**.
:::

## 2. One prompt for the layout, world book, and opening message

Click into the left input field and **paste the following verbatim**:

```
I want to build a light-novel-style Western isekai adventure card.
The protagonist is dropped into an unfamiliar forest and has to survive alone.
The AI plays the environment and narrator (third-person view describing what
the protagonist sees / feels). Avoid Eastern xianxia / cultivation / urban /
school settings, and avoid post-apocalyptic dark fantasy.

Build a minimal viable CardApp first:
- A 4-cell status bar at the top: Day, Stamina, Hunger, Mood
- A message rendering area in the middle
- An input box and a send button below
- The required quick buttons (stop generation, switch chat, new save, close chat)
  at the bottom

All state variables use the isj_ prefix (isj_day / isj_hp / isj_food / isj_mood).
Style should match a light-novel Western isekai vibe; you decide the specific
colors / fonts / layout.
```

![Sending the first prompt](/images/walkthrough/isekai/step-03-first-prompt.png)

After you send, Studio inspects the card and lays out its plan instead of writing immediately. Since the card has not enabled CardApp, it first asks whether to enable it (a "yes" is enough).

Once confirmed, it does the following in one go, with no need to split the work across rounds:

- enables CardApp for this card
- writes the interface code: status bar, message area, input area, and common control buttons
- creates the paired world book with the state record and worldview conventions
- writes the opening message and initializes the state variables
- links the world book to the card

Each edit opens a dialog with the changes, and nothing is written until you confirm.

![AI working: edits and confirmations](/images/walkthrough/isekai/step-04-first-round-work.png)

::: tip AI content goes into the world book, not the main prompt
The AI does not touch the card's main prompt. This follows [Luker's CardApp authoring convention](/development/card-developers): a card's main prompt overrides the system section your chat-completion preset already designed, so card content belongs in world book entries to coexist with the preset. Studio AI follows this by default.
:::

When the AI finishes, the center preview reloads and shows the generated CardApp:

![First round running](/images/walkthrough/isekai/step-05-first-round-running.png)

## 3. If something is off, ask the AI

After one round you might want a different palette, a different button order, a different tone in the narration, or a richer NPC setting. Say so in the left chat, and Studio AI continues with the existing context:

::: tip Ask directly
- "Reorder the bottom buttons to Send / Rewrite / Old Volume / New Chapter / Close Volume"
- "Can the status bar font be a bit larger?"
- "On that NPC entry, hint that the player can give them gifts"
- "The end of the opening message feels too cold; try a brighter scene"

Don't worry about prompt phrasing. Describe what you want and the AI iterates. If the result is wrong, keep iterating.
:::

## 4. End-to-end test

Send a roleplay message (anything will do) and watch the status bar values change with the story.

With a few natural-language conversations, you now have a card with:

- ✓ A working interface (status bar and common control buttons)
- ✓ Worldview and NPC settings in the bound world book
- ✓ An opening message that initializes the state
- ✓ Real roleplay immersion when running

Throughout this process you **never read a line of code**, never enabled CardApp by hand, and never created a world book entry by hand.

## 5. (Advanced) Wire up image generation

::: warning Prerequisite: SD/ComfyUI backend
This section requires the SillyTavern [Image Generation extension](https://docs.sillytavern.app/extensions/stable-diffusion/) backend (local Stable Diffusion, ComfyUI, or a remote API). Skip this section without a backend.
:::

```
I'd like the CardApp to auto-generate images when the AI describes a new scene.
Don't generate images for player-only dialog or inner monologue.
Also add a "Draw what's visible" button at the bottom that re-renders the
scene of the most recent AI message on demand.

For users without an image-generation backend: silently skip / hide the button,
don't surface errors, and don't break other CardApp features.
```

![Inline scene illustration](/images/walkthrough/isekai/step-09-scene-image.png)

![Triggering "Draw what's visible"](/images/walkthrough/isekai/step-10-redraw-button.png)

## Prompting notes

An effective Studio brief does not need to be long; stating the goal is enough.

1. **Describe appearance and behaviour**
   - Example: "A 4-cell status bar at the top: Day / Stamina / Hunger / Mood"
   - Leave the implementation to Studio, such as when to re-render the bar

2. **Separate constraints from latitude**
   - Write fixed requirements as constraints, such as an `isj_` variable prefix.
   - Leave the rest to Studio, such as palette, fonts and layout.

3. **State the gap from your expectation**
   - Name the expected result and the current one: "The status bar should show four items; it currently shows two. Add the missing ones."
   - Append the clarification to the original brief.

4. **Review changes before approving**
   - Every edit asks for confirmation, so each one can be checked.
   - Studio handles common controls, variable recording, world book linkage and escaping.

5. **Ask Studio how a mechanism works**
   - For example: "At which step is a state variable written?" or "When does this world book entry trigger?"
   - Studio can read the project files and documentation and answer questions about the current card.

## Next steps

- [CardApp Overview](/features/cardapp) — CardApp's core concepts
- [Card Developer Guide](/development/card-developers) — the full CardApp API and authoring conventions
- [Variables](/features/variable-op-log) — how variables update with the conversation
- [State System](/features/state-system) — floor state, triggers, and global variables
- [Studio Capability Reference](/features/card-editor/studio) — editor, version history, and AI operations
