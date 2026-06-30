# Chat Merge and Split

Combine several chats into one in the order you pick, with per-source range
trimming. Or cut one chat into multiple new chats at the points you choose.
Source chats are always preserved.

## Merging chats

1. Open **Past Chats** (the chat-list popup for the current character or
   group), then click the merge icon in the popup header.

   ![Two chats ready to merge](/screenshots/chat-merge-split/01-two-chats-ready.png)

2. Click **+ Add chat** to pick a source chat. Add as many as you want. The
   same chat can be added more than once.

   ![Merge dialog with two sources](/screenshots/chat-merge-split/02-merge-dialog-two-sources.png)

3. **Drag the ⋮⋮ handle** on the left of each row to reorder. With three or
   more sources you can move any row to any position.

   ![Merge dialog with three sources](/screenshots/chat-merge-split/04-merge-dialog-three-sources.png)

   ![After dragging to reorder](/screenshots/chat-merge-split/05-merge-dialog-after-drag.png)

4. **Set the `from` / `to` numbers** to include only a slice of the source.
   The colored bar shows which messages are included. Click **Use all** to
   reset a row to the full chat.

   ![Trimmed segments](/screenshots/chat-merge-split/06-merge-dialog-trimmed.png)

5. Type a **target name** at the top and click **Merge**. The new chat opens
   automatically.

   ![Merged chat opened](/screenshots/chat-merge-split/03-merged-chat-opened.png)

## Splitting a chat

1. Find the message where you want the chat to split. Click the
   ✂ **Split Chat** icon in that message's button bar.
2. The dialog opens with one split point pre-filled at that message's index.
   Click **+ Add point** for more split points; type into the numeric inputs
   to fine-tune.

   ![Split dialog with three segments](/screenshots/chat-merge-split/07-split-dialog-three-segments.png)

3. Rename each segment if you want, then click **Split**. The new chats are
   created in your chat list; the source chat is left untouched.

## Group chats

Merge works the same way for group chats. Open Past Chats from a group and
follow the merge flow above.

![Group chats ready to merge](/screenshots/chat-merge-split/20-group-two-chats-ready.png)

![Group merge dialog](/screenshots/chat-merge-split/21-group-merge-dialog-two-sources.png)

The merged group chat is registered with the group automatically, so it
appears in the group's Past Chats list and opens like any other group chat.

## Notes

- The new chats contain only messages. **Plugin state — memory graph,
  orchestrator, search tools, and similar per-chat sidecars — does not
  migrate.** You will need to regenerate it in the new chat.
- Source chats are never modified or deleted.
- If the target name is already in use, ` (2)`, ` (3)`, ... is appended
  automatically.
- Works the same way in single-character chats and group chats. Same-source
  only: you cannot merge a character chat with a group chat.
