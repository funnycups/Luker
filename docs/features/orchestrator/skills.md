# Skills

When the orchestrator dispatches an agent, that agent only sees the Skills you have made visible to it, not the whole library. This page explains how to attach a Skill to a specific agent.

For what a Skill is and how to write one, see [the Skills overview](/features/skills/).

## Ways to attach a Skill

**Let the Studio do it (recommended).** When you ask AI Iteration Studio to write or edit a Skill, say who should see it — "every agent in Director mode" or "only the voice reviewer". It wires the Skill into the right place during the same approval round, so you do not have to decide which layer it belongs to. See [Shaping roleplay output with Skills](/recipes/rp-skills-walkthrough) and [Writing Skills with the Studio](/features/orchestrator/iteration-studio#authoring-skills-via-iter-studio).

**Attach it yourself.** Open the Director editor in the orchestrator panel and scroll to the Skill list. Each agent has its own list, and a shared list at the top applies to every agent. Pick a Skill from the dropdown, choose **Add**, then save.

![Director editor with the Skill list and a freshly added Skill](/images/skills/rp-demo-11-director-chip-added.png)

If you are unsure which list to use, let the Studio decide.

## What the agent sees

At dispatch time the runtime prepends a short catalog to the agent's system prompt: names and descriptions only, no bodies. The agent judges which one is relevant and reads the body by name when it needs it.

The catalog lists names only. Bodies resolve in the order character card, preset, global, with later scopes overridden by earlier ones. A character-scoped Skill therefore overrides a global Skill of the same name while that card is loaded, and the global version returns when you switch cards.

## Related pages

- [Skills overview](/features/skills/) — structure and scopes
- [Managing Skills](/features/skills/management) — install, import, delete and move scopes
- [Authoring Skills](/features/skills/authoring) — writing rules for Skill bodies
- [Orchestrator integration](/features/skills/orchestrator-integration) — inheritance, wildcards and deny lists
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — let the AI write Skills for you
- [Shaping roleplay output with Skills](/recipes/rp-skills-walkthrough) — end-to-end walkthrough
