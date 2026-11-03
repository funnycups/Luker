# Preset Groups

A flat preset dropdown gets hard to scan once you have a lot of presets. Preset Groups puts them into named groups, shown in the dropdown as a group header with its members underneath.

![Preset groups in the dropdown](/images/presets/preset-groups.png)

## Managing groups

Right-click a preset in the dropdown:

- **New Preset Group…** — enter a name; the selected presets go into the new group.
- **Move to group** — move the current preset into an existing group.
- **Remove from preset group** — send it back to the ungrouped list.

Each group header has buttons for a sub-group, rename, and delete. Deleting a group returns its presets to the ungrouped list. Groups nest, and sub-groups are indented under their parent.

Groups are stored per API type. Switching API type shows that type's groups.

Renaming a preset updates its name inside the group; deleting a preset removes it from the group.

## Display

Click a group header to collapse or expand it. Ungrouped presets stay at the top of the list.

## Related features

- [Prompt Groups](/features/prompt-groups) — Grouping system in the prompt manager
- [Completion Preset Assistant](/features/preset-assistant) — AI-assisted understanding and adjustment of preset parameters
