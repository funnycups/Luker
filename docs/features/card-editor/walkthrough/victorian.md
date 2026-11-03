# Build a Character Card with Memory Graph and Multi-Agent Orchestration

This page uses a detective card to walk through CardApp Studio's full development flow: from one genre description, Studio creates Memory Graph node types, configures multi-agent orchestration, writes a card-specific world book, and builds a CardApp panel that updates with the case.

The four subsystems divide the work on one card: Memory Graph holds long-term memory, multi-agent orchestration prepares each reply, the world book supplies context and rules, and the CardApp displays state.

## What you get

The result is a detective card called **"Victorian Case File"**. <code v-pre>{{char}}</code> is a Holmes-style independent consultant in 1888 London. You play a client (or a visiting Scotland Yard inspector) bringing in a case file, and you investigate together.

The card connects the following subsystems:

- **Memory Graph** — creates four node types for the case: suspects, clues, forensic sites, and witnesses. After each reply, the AI extracts case information into nodes and connects them; on the next turn, recall brings the relevant records into context.
- **Multi-agent orchestration** — before each reply, a group of agents prepares the writing material: one summarizes the recent conversation, one plans what this turn should advance, one checks the draft for missed clues, contradictory testimony, and period errors, and the result is combined into an orchestration result for the main model.
- **Card-bound world book** — holds Victorian London context, detective procedure, and one entry that records the case state.
- **"Current Case" CardApp panel** — shows the case name, current status, suspects, and clues as the case progresses.

The setup runs on natural-language descriptions. Studio proposes the plan, writes the files, creates the world book, and links everything to the card.

## Prerequisites

- A working Luker instance
- A configured LLM API. Claude, GPT-5, and other models that support tool calling are recommended; Studio edits the card by calling tools and cannot work with a model that lacks this ability
- In the Extensions panel, choose the "Model request LLM preset" and "Model request API preset" for the Character Editor Assistant; Studio sends its AI calls through them

## 1. Create a blank card and open Studio

Open the right-side character panel, click "Create New Character", and name it **"Victorian Case File"**. Leave description, first message, and world info binding empty; Studio fills them in.

Then open the Extensions panel → expand "Character Editor Assistant" → click **"&lt;/&gt; CardApp Studio"**:

![Studio entry](/images/walkthrough/victorian/step-01-studio-entry.png)

::: tip Studio also works on cards without CardApp
The Character Editor Assistant routes cards without CardApp to the [popup](/features/card-editor/popup) and cards with CardApp to Studio. The Studio button can bring any card into Studio with the full feature set: Memory Graph node types, multi-agent orchestration overrides, regex scripts, world books, and card content. The popup only edits card content and world book entries.
:::

## 2. Describe the genre and let Studio propose a plan

Click into the Studio left-panel input and describe the result you want. The implementation is up to the model:

```
I want to build a Victorian-London detective character card from scratch.

- The character is an independent consultant in 1888 London. I play a client
  bringing in a case file, and we investigate together.
- The AI should remember the suspects, clues, forensic sites, and witnesses in
  the case, and recall them when they come up.
- Each reply should be drafted first, then checked for missed clues,
  contradictory suspect statements, and period errors, then rewritten.
- The world book holds Victorian London context and detective procedure.
- Build a "current case" panel showing the case name, status, suspects, and
  clues, updating with the conversation.

Work through this in whatever order makes sense. Propose each step first, and
write after I confirm.
```

![Sending the genre prompt](/images/walkthrough/victorian/step-02-first-prompt.png)

After you send, Studio lays out the overall plan before writing anything.

## 3. Studio proposes the Memory Graph structure

Studio starts with memory: it will add four node types to the Memory Graph for this card — suspects, clues, forensic sites, and witnesses — and lists the fields each type records. Suspects record a motive, an alibi, and a level of suspicion; clues record a discovery location and related suspects.

It also explains how the nodes connect: clues point to related suspects, and forensic sites point to the clues found there. During recall, the graph follows these relationships to find records relevant to the current scene.

It also explains why victims and deductions are not recorded as separate nodes: both are few in number and change quickly, so they fit better in the case summary and the conversation. Separate nodes would make the memory structure bloated.

::: tip Default and custom Memory Graph types
Memory Graph ships with events as its one core type, used for the timeline. A character card can add its own node types and fields for its genre, so the AI files extracted memories into a fixed structure. The "suspect" and "clue" types this detective card needs are such custom types. See [Memory Graph](/features/memory-graph) for details.
:::

## 4. Studio proposes multi-agent orchestration

Next is generation: Studio suggests Loop mode. Before each reply, one agent repeatedly calls tools in the same session, reading recent chat, the world book, and the Memory Graph to decide whether it has enough information. Once it does, it writes an orchestration result for the main model to turn into the reply.

This mode suits investigation: a case requires confirming the scene, witnesses, and timeline before deciding the next step, and a fixed flow cannot anticipate that. The cost is one extra model call per reply, in exchange for steadier deduction.

The orchestrator also offers other modes: Spec runs a fixed set of stages and nodes, Agenda lets a planning agent dispatch dynamically, and Director has a main agent write the reply directly. The Memory Graph and world book work in all of them.

## 5. After confirmation, Studio completes everything in one round

Reply "all confirmed, go with this plan, write it directly", and Studio starts a batch of edits:

![Studio writing everything](/images/walkthrough/victorian/step-05-tool-calls.png)

In one round it:

- adds the four Memory Graph node types for suspects, clues, forensic sites, and witnesses, scoped to this card
- configures Loop orchestration with a system prompt and tool switches, also scoped to this card
- creates the card-specific world book with Victorian London context, detective procedure, the case-state entry, Scotland Yard culture, and Whitechapel background
- writes the description, personality, first message, and scenario, and links the world book to the card

Each edit opens a dialog with the changes and is written after you confirm. You can approve them one at a time or all at once.

::: tip How the case-state entry drives the panel
One world book entry records the current case state. The entry holds both the state and the update rules: the AI reads it before each generation and writes new developments back as variables during its reply, and the CardApp panel reads those variables to refresh. See [Per-Message Variables](/features/variable-op-log) for details.
:::

::: tip Regex scripts too
Studio can also write and edit regex scripts, for example to strip thinking tags or transform display formats.
:::

## 6. Build the case panel

The final prompt:

```
Continue. Last step: the "current case" panel.
Show the case name, status, suspects, clues, and forensic sites, refreshed after
each reply.
Style: Victorian fog (dark parchment, serif type, dark red and amber borders).
Styling, palette, and values are yours.
```

Studio writes the panel and connects it to the case state.

## 7. End-to-end test

Exit Studio and send a regular roleplay message. Hand <code v-pre>{{char}}</code> a Whitechapel case file:

> "Detective, someone was murdered in Whitechapel last night, found in their own attic. The victim is Monica Wheeler, 35, a tutor; her husband Henry Wheeler reported it. I just transferred from Scotland Yard with the file and would like you to take the case."

### a. The chat reply

![End-to-end chat reply](/images/walkthrough/victorian/step-07a-chat-reply.png)

Two layers of constraint are at work in this reply: the world book entries set the period and procedure, and the orchestration result sets the direction of the investigation for this turn. The main model turns that material into dialogue instead of deciding the pace of the case itself.

### b. Inspect the orchestration

Open the **Run Panel** beside the chat, or the bottom drawer on narrow screens. It lists each round of this agent's reasoning, the tools it calls and their results:

![Multi-agent orchestration run panel](/images/walkthrough/victorian/step-07b-stage-output.png)

This is where to look when a round consults the wrong book, misses a memory, or ends early without enough information. When orchestration fails (misconfigured API, timeout, and so on), the panel marks the failure and generation falls back to a direct reply.

### c. Inspect the Memory Graph

In the Extensions panel, open the Memory section → "View Graph" to see the nodes and relationships accumulated by the conversation:

![Memory Graph visualization](/images/walkthrough/victorian/step-07c-memory-graph.png)

The graph holds suspects, clues, forensic sites, witnesses, and events, with edges for their relationships. After each reply, the Memory Graph extracts the case information that appeared; on the next turn, the related records enter the context automatically. The next time the conversation mentions Henry Wheeler, his testimony and the connected clues come with it.

## 8. Watch the panel update

Keep chatting. The AI updates the case state in its replies, and the panel refreshes:

![CardApp panel after two turns: suspects, clues, and forensic sites appearing](/images/walkthrough/victorian/step-06b-cardapp-turn2.png)

## Prompting notes

An effective brief states the goal and the desired result; the implementation is left to Studio.

1. **State the genre and the result**
   - Example: "Victorian London detective card; needs Memory Graph case node types, multi-agent orchestration, a card-specific world book, and a panel that updates with the conversation".
   - Studio proposes the structure, including which fields each memory type needs.

2. **Review the structural proposal first**
   - Studio presents a structure and writes it after you confirm.
   - To adjust it, state the change, for example "merge witnesses into suspects" or "let the planning agent decide which thread to investigate first".

3. **Ask Studio to explain a choice**
   - Example: "Why aren't victims recorded separately?"
   - Studio explains that this information changes quickly, so the case summary and world book entries keep it more reliably.

## Next steps

- [CardApp Studio](/features/card-editor/studio) — Studio's capabilities, layout, and controls
- [Memory Graph](/features/memory-graph) — node types, extraction, and recall
- [Multi-Agent Orchestration](/features/orchestrator/) — execution modes, run panel, and result injection
- [Loop Mode](/features/orchestrator/loop) — single-agent orchestration through a tool loop
- [Per-Message Variables](/features/variable-op-log) — how variables update with the conversation
