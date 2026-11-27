# Skill management

The **Manage skills...** button under **Workbench → Orchestration → Setup** opens the skill manager popup where you install, edit, move, and remove skills. This page walks through each surface.

::: tip Where to find it
Open **Workbench → Orchestration → Setup** and click **Manage skills...** (or open **Extensions → Completion Preset Assistant → Bundle skills with this preset** to jump directly to the active preset's scope).
:::

## Subpanel overview

The skill manager has two top tabs, plus import actions in the **Installed** toolbar:

- **Installed** — skills installed in your workspace. Filter by scope or show **All scopes**.
- **Browse bundled** — skills shipped with Luker, with each row showing whether your local copy matches, differs, or is not installed.
- **Import toolbar** — install skills via **Import bundled**, **Import from file...**, or **Import from URL...**.

![Skill manager subpanel, Installed tab](/images/skills/manager-installed-tab.png)

## Installed

Each row shows:

- `name` — the skill's frontmatter `name`. Click to open the inline editor.
- `description` — one-line summary from the frontmatter.
- **Scope** — badge indicating whether the skill belongs to the global, chat completion preset, orchestrator preset, or character scope.
- `size` — file count + total bytes.
- **Used by** — chip count of agents in the active orchestrator profile that reference this skill in their visible list.

Row actions (right side):

| Action | What it does |
|---|---|
| **View** | Read-only Markdown render of `SKILL.md`. |
| **Edit** | Opens the inline editor (see [Inline editor](#inline-editor) below). |
| **Move to...** | Atomic move to another scope. References (which use name only) stay valid. |
| **Rename** | Atomic rename within the current scope. The directory and frontmatter `name` update together. References that pointed at the old name turn grey (see [Stale references](#stale-references)). |
| **Delete** | Removes the skill directory. References continue to grey out instead of breaking dispatch. |

## Browse bundled

Browse bundled compares your local copy of each shipped skill with the bundled version. Each row shows one of the following states:

| Badge | Meaning |
|---|---|
| **Installed** | Local copy is byte-identical to the bundled version. |
| **Differs** | A local copy exists but its hash differs from the bundled one — you or an AI iteration session edited it. |
| **Not installed** | No local copy. Click **Install this** to materialize it into `global`. |

![Browse bundled, mixed states](/images/skills/manager-bundled-tab.png)

The **Install all bundled** button at the top installs every bundled skill, replacing local copies whose content differs.

::: warning Overwrite is destructive
**Install all bundled** overwrites matching local copies instead of merging. If you edited `event-summary-rules-zh` locally, installing the bundled version replaces your edits.
:::

## Import

Entry points:

### Import from file...

Upload a `.zip` of a single skill directory or a raw `SKILL.md`. The server validates the upload, previews any conflicts (`new` / `same` / `different`), and waits for your decision on each conflict before committing.

### Import from URL...

Paste an `https://...` URL pointing to a raw `SKILL.md` or zip bundle. For multi-file skills without a zip URL, use **Import from file...**.

### Import bundled

The same action as **Install all bundled** under **Browse bundled**, listed in the **Installed** toolbar for convenience.

## Inline editor

Clicking **Edit** on a skill row opens an in-popup editor:

![Inline skill editor](/images/skills/skill-editor.png)

- Left pane: file tree (`SKILL.md` and any sub-files). Click to switch.
- Right pane: Markdown editor with YAML-aware frontmatter highlighting.
- Top bar: file path, dirty indicator, **Save**, and **+ New file**.

Every save validates path safety, size limits, and frontmatter parsing before atomically replacing the original file.

`SKILL.md` can be edited but not deleted from the editor. The skill itself can be deleted from the row action.

::: tip Edit skills with AI
[AI Iteration](/features/orchestrator/iteration-studio#authoring-skills-via-iter-studio) in Workbench writes and modifies skills: describe the change, and the AI drafts it through the same install path.
:::

## Embed export — into presets and cards

Skills are most useful when they ship with the artifact that depends on them. Exporting a preset or a character card offers to bundle the matching skills into the exported file.

An exported file carries bundled skills only when you choose **Include**. Choosing **Skip**, exporting with no confirm because there are no skills to bundle, or a failed bundling produces a file without bundled skills, even when the preset or card was imported with them.

### Chat completion preset export

When the exported chat completion preset has skills in its preset scope, Luker asks **Include preset-scope skills in this export?**. **Include** bundles them into the exported JSON; **Skip** exports the preset without them.

The Completion Preset Assistant's **Bundle skills with this preset** button opens the Skill Manager filtered to the current preset's scope, so you can review or add the skills that this export bundles.

### Orchestrator preset export

Exporting an orchestrator preset asks **Include all skills active for this orchestrator preset in the export?** when any agent in the preset can see skills. **Include** bundles every such skill from the global, chat completion preset and orchestrator preset scopes. Character-scope skills are not bundled.

### Character card export

When the character has skills in its character scope, exporting the card through **Export and Download** asks **Include this character's skills in the export?** before the PNG or JSON file downloads. **Include** bundles them into the exported file. Skills bundled inside the card's card-bound chat completion presets are not exported. If the skills cannot be bundled, the card is exported without them and a warning toast appears.

### Installing bundled skills

Luker shows an install dialog when you first open an imported character card that carries bundled skills, and when you import a chat completion preset or orchestrator preset that carries them:

![Embed import preview with a conflict](/images/skills/skill-conflict-replace-dialog.png)

The dialog lists every bundled skill with its conflict state. For a conflicting entry, choose **Skip** to keep your local version or **Replace skill** to use the version from the file. Entries whose content matches an installed skill are skipped; new entries install directly. **Install** writes the skills into the scope of the card or preset:

- character card → the character scope, including skills bundled inside the card's card-bound chat completion presets
- chat completion preset → the chat completion preset scope
- orchestrator preset → the orchestrator preset scope

The dialog appears once per card or preset.

## Scope migration

You can move a skill from `global` → `preset` → `character` (or back) at any time via the **Move to...** row action. The migration is an atomic filesystem rename — no copy, no temp state.

Why this is safe: orchestrator profiles reference skills by **name only**, never by scope. A skill named `voice-rules` resolves through later-wins precedence (character > preset > global) regardless of the scope it currently resides in. Moving the skill doesn't break any reference; it only changes when the skill is visible.

Typical migrations:

- **`global` → `character`** — You authored a writing rule, used it across cards, then realized one card has a specialized variant. Move it to that card's scope and let the more general version stay in `global`. Now both coexist; the card-scope one wins when its card is loaded.
- **`preset` → `global`** — A skill you packaged with one preset turned out to be useful everywhere. Promote it.
- **`character` → `global`** — A card-specific skill that ended up generalizing. Promote it.

## Stale references

When you rename or delete a skill that an orchestration profile references, the reference keeps the old name. The runtime cannot find it, so the agent does not see the skill, without an error or a blocked dispatch.

In **Workbench → Orchestration → Setup**, stale references are greyed out and show the tooltip **"Skill is not installed in your current data dir."** A couple of clicks fix it — either rename in the profile, or re-add the skill.

A missing skill does not block an agent dispatch, and adding or removing skills requires no matching profile edit.

## Related

- [Skills overview](/features/skills/) — what a skill is, the scopes
- [Authoring skills](/features/skills/authoring) — write your own
- [Orchestrator integration](/features/skills/orchestrator-integration) — wire skills to a profile
- [Skills extension API](/development/extension-api/skills) — programmatic management from extensions
- [Preset Assistant](/features/preset-assistant) — derives `-orchestrator` presets and opens the Skill Manager on the preset's scope
