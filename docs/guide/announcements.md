# Announcements

Announcements let an administrator broadcast a Markdown message to every local account on the same Luker instance. Typical uses:

- Telling other accounts about an upgrade that moved or renamed a UI element.
- Notifying users about scheduled downtime or maintenance.
- Acknowledging an incident ("I just restored the staging CardApp from backup, your bookmarks may be stale").

If you run Luker on your own without other local accounts, this feature has nothing to do for you.

## Prerequisites

Announcements rely on the multi-user account system. Enable it in `config.yaml`:

```yaml
enableUserAccounts: true
```

Without multi-user mode there is no concept of "other accounts" to broadcast to.

The publishing UI is gated by admin rights — only accounts with admin role can create, edit, or delete announcements. Every authenticated account sees the receiving UI (modal / banner / inbox).

## Publishing an Announcement

Open the admin panel and switch to the **Announcements** tab. Click **New announcement**.

A form opens with four fields:

- **Level**: one of `Info`, `Warning`, `Critical`. The level controls how aggressively the announcement reaches users (see [Levels](#levels) below).
- **Title**: short headline (up to 200 characters). Shown in the modal header, the banner, and the inbox row.
- **Body (Markdown)**: full announcement text in Markdown (up to 10 000 characters). Bold, italic, lists, links, code blocks, and headings are all supported.
- **Preview**: live render of the Markdown body — exactly what users will see.

Click **Create** to publish. The announcement immediately becomes visible to all accounts.

## Levels

Each level routes differently on the user side:

| Level | When a user has it unread |
|---|---|
| **Critical** | Login-time modal blocking the screen until the user clicks **Mark all as read**. Multiple unread critical items are merged into one modal so the user is only interrupted once. |
| **Warning** | Top banner above the chat area. The user dismisses it with the × button; the next unread warning automatically takes its place. |
| **Info** | No proactive UI. The announcement is only visible by opening the inbox. |

All levels — including `Info` — contribute to the unread badge on the **Announcements** button.

Pick the level honestly. Most operational notices are `Info` or `Warning`; reserve `Critical` for things the user must read before continuing (security, data loss, breaking change).

## How Users See Announcements

### The Inbox

The welcome screen carries an **Announcements** button in the shortcuts row (next to Docs / GitHub / Discord / Temporary Chat). It shows a red badge with the unread count (`9+` past nine). Clicking it opens the inbox, which lists every active announcement (newest first). Clicking a row expands the Markdown body inline and marks the announcement as read.

The button only appears on the welcome screen, not inside an open chat. To check the inbox, return to the welcome screen by closing the current chat (the X above the chat).

### Critical Modal at Login

When a user opens Luker and there are unread `Critical` announcements, a modal pops up listing all of them. The **Mark all as read** button closes the modal and marks every listed announcement as read in one call. The user is not interrupted again on subsequent loads unless a new `Critical` announcement is published.

### Warning Banner

Unread `Warning` announcements appear as a banner above the chat area. The × button dismisses the current warning (marking it read) and immediately reveals the next unread warning, if any.

## Editing and Deleting

From the **Announcements** tab in the admin panel:

- The pencil button on a row opens the edit form with the existing content prefilled. Submitting saves the new content. **Edits do not reset users' read state** — fixing a typo will not re-pop the modal for everyone who already saw the original.
- The trash button hard-deletes the announcement. There is no undo and no archive — once deleted it is gone from every account's inbox immediately. A confirmation dialog protects against accidental clicks.

## Read State

Each account tracks which announcements it has read; the admin does not see a per-user read report. Read state survives logouts and server restarts.

If an account never opens the inbox and never logs in while an `Info` announcement is active, that announcement stays unread for them indefinitely (it simply waits in the inbox). This is intentional — `Info` is opt-in.

## Field Limits

- Title: 1–200 characters (whitespace trimmed before validation).
- Body: 1–10 000 characters (whitespace trimmed; Markdown source counts toward the limit).
- Title and body are stored as a single language — the receiving UI does not translate announcement content. UI chrome (button labels, modal headers) does follow each account's chosen interface language.
