# State System

Character cards, chats and presets can carry custom state. A CardApp uses it for affinity, quest progress and inventory; an extension uses it for per-chat data. Neither has to rewrite the card or the chat history.

State is isolated by namespace, so each extension or CardApp reads and writes its own data. State is created on first write, follows its owner when that object is renamed or deleted, and survives a server restart.

```d2
direction: right

OBJ: "Character card, chat or preset" {
  MAIN: "The object's own data" {
    style.fill: "#e1f5ff"
  }
  NS1: "Namespace A\nstate of one extension"
  NS2: "Namespace B\nstate of one CardApp"
}

READ: "Each extension touches only its namespace"
LIFE: "Renaming or deleting the object\nmoves or removes the state with it"

OBJ -> READ
OBJ -> LIFE
```

## The three kinds

| Kind | Attached to | Typical use |
| --- | --- | --- |
| Character state | A character card | Memory summaries, game progress |
| Chat state | A chat | Generation acknowledgements, per-chat extension data |
| Preset state | A preset | Preset-level configuration or runtime data |

Luker manages the storage layout for preset state. Do not move or edit state files by hand; they can fall out of step with the current format.

## Floor state

Plain chat state is overwritten as a whole. Floor state records which floor and swipe each write belongs to. When messages are deleted or edited, or a swipe is switched, Luker replays the commits that still apply so plugin state follows the active branch instead of an old timeline.

## Related pages

- [CardApp](/features/cardapp) — in-card application system
- [Extension API](/development/extension-api/) — extension development interface
- [Floor state](/development/extension-api/chat-and-state#floor-state) — developer reference for chat state with automatic rewind
- [Incremental sync](/improvements/incremental-sync) — incremental saving for chat data
