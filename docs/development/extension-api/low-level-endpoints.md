# Low-Level Endpoint Reference

> [!WARNING]
> The following endpoints are provided only as a reference for advanced debugging and integration scenarios where `Luker.getContext()` cannot be used. They are same-origin web application routes, not the primary plugin API contract. Normal plugin development should use the Context API described in the other Extension API pages.

Plugins can also read and write World Info entries through the context API; the raw HTTP routes for World Info are listed below.

## Character Chats

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/save` | Save chat (patch-first) |
| POST | `/api/chats/get` | Get chat list |
| POST | `/api/chats/delete` | Delete chat |
| POST | `/api/chats/rename` | Rename chat |
| POST | `/api/chats/export` | Export chat |

## Group Chats

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/group/save` | Save group chat |
| POST | `/api/chats/group/get` | Get group chat list |
| POST | `/api/chats/group/delete` | Delete group chat |

## Chat State

| Method | Path | Description |
|------|------|------|
| POST | `/api/chats/state/get` | Batch read state |
| POST | `/api/chats/state/patch` | Incrementally update state |
| POST | `/api/chats/state/delete` | Delete state |

## Settings

| Method | Path | Description |
|------|------|------|
| POST | `/api/settings/save` | Save settings (patch-first) |
| POST | `/api/settings/get` | Get settings |

## World Info

| Method | Path | Description |
|------|------|------|
| POST | `/api/worldinfo/save` | Save World Info (patch-first) |
| POST | `/api/worldinfo/get` | Get World Info |

## Search / Visit

| Method | Path | Description |
|------|------|------|
| POST | `/api/plugins/search/search` | Execute search |
| POST | `/api/plugins/search/visit` | Visit a URL and extract content |

## Patch Operation Format

Message patches use the RFC 6902 JSON Patch format:

```json
[
  { "op": "replace", "path": "/4/mes", "value": "New content" },
  { "op": "add", "path": "/4/extra/note", "value": "Note" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

Object patches (`meta/patch`, `state/patch`, `settings/patch`, `worldinfo/patch`) also use the same RFC 6902 format.

## Patch Conflicts and Integrity Semantics

- The server validates whether the path in a patch operation exists
- `replace` operations require the target path to already exist
- `add` operations create paths that do not exist
- On conflict, an error is returned; the client should retry or fall back to a full save

## Chat-Completions Request Body

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

The `secret_id` field allows overriding the API key used at the request level, suitable for scenarios such as multi-agent orchestration that require different keys.
