# Orchestrator Integration

Every agent in the orchestrator has a Skill list that decides which knowledge packs it can read at runtime.

## Editing an agent's Skills

In the orchestration editor, each agent card has a **Skill** row:

- **Inherit marker**: use the mode's default list.
- **Named entries**: Skills this agent can also see. Remove one by selecting it; add one with **Add** from installed Skills.
- **Deny list**: Skills this agent must not see. Deny takes precedence over visibility.

The **Skill** row at the top of the panel is the mode default and applies to every agent in that mode. Editing one agent changes only its override.

Switching execution mode re-renders the Skill rows from that mode's configuration. Each mode keeps its own policy.

## How the lists combine

- No agent list: inherit the mode default.
- Agent list starts with the inherit marker: keep the mode default and append the rest.
- Agent list does not start with the marker: replace the mode default.
- Deny lists from both levels are combined, and a denied name wins.

## What the agent sees

At runtime, the names and descriptions of visible Skills are added to the agent's context as a short catalog. The agent reads a body by name when needed and can search within a Skill. It can only access Skills in its visible set.

## Missing Skills

Skills are referenced by name. If one is renamed, deleted or not installed, the runtime skips it at dispatch time; the agent does not see it, and dispatch still succeeds. The editor greys out the entry and marks it missing.

An orchestration still runs when Skills shipped with a card or preset are not all installed. References recover once the missing Skill is installed.

## Editing with AI

[AI Iteration Studio](/features/orchestrator/iteration-studio) can change bindings in natural language. Describe which agent should see which Skills, and it submits the change for review.

## Related pages

- [Skills overview](/features/skills/) — what Skills are, scopes and visibility
- [Authoring Skills](/features/skills/authoring) — write your own
- [Managing Skills](/features/skills/management) — install, move, delete
- [Director mode](/features/orchestrator/director) — the bundled multi-agent profile with full Skill integration
- [AI Iteration Studio](/features/orchestrator/iteration-studio) — change the policy in natural language
