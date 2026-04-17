# Chat Management

In Luker, each conversation with a character is an independent "chat." You can create multiple chats with the same character, each with its own separate message history. This page covers the basic chat management operations.

## Creating and Switching Chats

### Creating a New Chat

After selecting a character, click the "New Chat" button in the chat interface to create a new conversation. The new chat starts with the first message defined in the character card.

### Switching Chats

Click the chat list button to view all chats with the current character. Click any entry to switch to it. Each chat's message history is completely independent — switching won't lose any content.

### Deleting Chats

In the chat list, you can delete chats you no longer need. Luker provides an Undo Toast — if you accidentally delete a chat, you can undo it within a short time window.

### Renaming Chats

You can set a custom name for a chat to easily distinguish between multiple conversations.

## Message Editing

During a conversation, you can edit previously sent messages:

- **Edit user messages**: Click the edit button next to a message to modify what you previously sent
- **Edit character messages**: You can also edit the AI's responses to fix unsatisfactory content
- **Delete messages**: Delete single or multiple messages

::: tip
Editing a message won't automatically regenerate subsequent responses. If you want the AI to respond based on the modified content, you'll need to manually trigger regeneration.
:::

## Swipe and Regenerate

Swipe and Regenerate are two different operations:

- **Swipe**: Switch between multiple AI response versions on the same message (swipe left/right or click arrows) without making a new AI request. A new generation request is only triggered when you swipe past the last version.
- **Regenerate**: Request the AI to generate a new response, replacing the current version.

How to use:

- **Desktop**: Click the left/right arrow buttons on the AI's last message to swipe
- **Mobile**: Swipe left/right on the AI's last message
- **Regenerate**: Click the regenerate button in the message action bar

Swipe characteristics:

- All swipe versions are preserved — nothing is lost
- You can switch between existing versions at any time without triggering new AI requests
- Swipe only works on the last AI message
- Swiping past the last version triggers a new AI generation, similar to regenerate but preserving previous versions

### Continue Generation

If the AI's response was cut off (e.g., hitting the token limit), you can use the "Continue" feature to have the AI keep writing from where it left off, rather than regenerating the entire response.

## Branching

Branching allows you to create a new conversation path from any point in the dialogue. Imagine: at message #10, you want to try a different choice — you can create a branch from message #10, explore a different path in the new branch, while keeping the original conversation intact.

This is very useful for exploring different plot directions.

## Group Chats

Group Chats allow you to put multiple characters in the same chat and have them interact with each other. You can:

- Create a character group and add multiple characters
- In a group chat, characters take turns speaking
- Control the speaking order and trigger method

::: info
Each character in a group chat uses the settings from their own character card, including bound world info and presets.
:::

## Chat Import and Export

### Exporting Chats

You can export chat logs as JSON files for backup or sharing. Exported files contain the complete message history.

### Importing Chats

Import chat logs from JSON files. Imported chats appear in the corresponding character's chat list.

## Luker's Incremental Sync

Luker has made significant improvements to how chat data is saved.

### The Problem

In SillyTavern, every message send, message edit, or even just swiping through responses transfers the **entire chat file** between frontend and backend. For long conversations, this means transferring large amounts of data with every operation — wasteful in bandwidth and error-prone.

### Luker's Improvement

Luker uses **incremental patch endpoints** to save chat data. Each operation only transfers the changed portion (following the RFC 6902 standard), not the entire chat file. For example:

- Sending a new message: Only the new message content is transferred
- Editing a message: Only the modified portion is transferred
- Toggling a setting: May only require transferring a few dozen bytes

Additionally, Luker's backend **persists chat data in real time**, avoiding the message loss issues that can occur in SillyTavern where the frontend is responsible for triggering saves.

::: tip
Incremental sync is transparent to users — you don't need to do anything extra. For cloud-deployed users, this improvement significantly reduces bandwidth consumption.
:::

## Offline and Disconnection

If the connection between your browser and the Luker backend is interrupted (e.g., network fluctuations, Wi-Fi switching, device sleep), you don't need to worry about data loss:

- **Sent messages won't be lost** — All messages that reached the backend have been persisted to disk in real time; frontend disconnection doesn't affect them
- **Auto-sync on reconnection** — When the connection is restored, Luker automatically syncs the frontend and backend data states, ensuring what you see matches the server
- **Generation interruption protection** — If the AI is generating a response when the connection drops, the already-generated content is safely saved by the backend and won't be lost due to frontend crashes

This is made possible by Luker's [Incremental Sync](/improvements/incremental-sync) and [Backend Real-Time Storage](/improvements/backend-storage) mechanisms — data changes are persisted the instant they reach the backend, rather than relying on the frontend to trigger saves.

## Chat Persona Lock

Luker supports locking a user persona to a specific chat. When enabled, switching to that chat automatically restores the corresponding persona, and switching to other chats restores the previous one. This is very convenient when you use different personas for different characters.

## Next Steps

- Learn the basics of [Character Cards](/basics/character-cards)
- Learn how the [Preset System](/basics/presets) affects AI responses
- Learn how to configure [API Connections](/basics/connections)
- Dive deeper into [Incremental Sync](/improvements/incremental-sync) and [Backend Real-Time Storage](/improvements/backend-storage) technical details
