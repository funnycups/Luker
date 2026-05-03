# 底層端點參考

> [!WARNING]
> 以下端點僅供進階除錯和無法使用 `Luker.getContext()` 的整合場景參考。它們是同源 Web 應用路由，不是主要的外掛 API 契約。正常外掛開發應使用其他擴充 API 子頁面所述的 Context API。

外掛也可以透過 context API 讀寫世界書條目；下面列出世界書的原始 HTTP 路由。

## 角色聊天

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/save` | 儲存聊天（patch-first） |
| POST | `/api/chats/get` | 取得聊天列表 |
| POST | `/api/chats/delete` | 刪除聊天 |
| POST | `/api/chats/rename` | 重新命名聊天 |
| POST | `/api/chats/export` | 匯出聊天 |

## 群組聊天

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/group/save` | 儲存群組聊天 |
| POST | `/api/chats/group/get` | 取得群組聊天列表 |
| POST | `/api/chats/group/delete` | 刪除群組聊天 |

## 聊天狀態

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/state/get` | 批次讀取狀態 |
| POST | `/api/chats/state/patch` | 增量更新狀態 |
| POST | `/api/chats/state/delete` | 刪除狀態 |

## 設定

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/settings/save` | 儲存設定（patch-first） |
| POST | `/api/settings/get` | 取得設定 |

## 世界書

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/worldinfo/save` | 儲存世界書（patch-first） |
| POST | `/api/worldinfo/get` | 取得世界書 |

## 搜尋/存取

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/plugins/search/search` | 執行搜尋 |
| POST | `/api/plugins/search/visit` | 存取 URL 並提取內容 |

## Patch 操作格式

訊息 patch 使用 RFC 6902 JSON Patch 格式：

```json
[
  { "op": "replace", "path": "/4/mes", "value": "新內容" },
  { "op": "add", "path": "/4/extra/note", "value": "備註" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

物件 patch（`meta/patch`、`state/patch`、`settings/patch`、`worldinfo/patch`）也使用相同的 RFC 6902 格式。

## Patch 衝突與完整性語義

- 伺服端會驗證 patch 操作的路徑是否存在
- `replace` 操作要求目標路徑已存在
- `add` 操作會建立不存在的路徑
- 衝突時回傳錯誤，用戶端應重試或回退到全量儲存

## Chat-Completions 請求體

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

`secret_id` 欄位允許在請求級別覆蓋使用的 API 金鑰，適用於多 Agent 編排等需要不同金鑰的場景。
