# 底层端点参考

> [!WARNING]
> 以下端点仅供高级调试和无法使用 `Luker.getContext()` 的集成场景参考。它们是同源 Web 应用路由，不是主要的插件 API 契约。正常插件开发应使用其他扩展 API 子页面所述的 Context API。

插件也可以通过 context API 读写世界书条目；下面列出世界书的原始 HTTP 路由。

## 角色聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/save` | 保存聊天（patch-first） |
| POST | `/api/chats/get` | 获取聊天列表 |
| POST | `/api/chats/delete` | 删除聊天 |
| POST | `/api/chats/rename` | 重命名聊天 |
| POST | `/api/chats/export` | 导出聊天 |

## 群组聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/group/save` | 保存群组聊天 |
| POST | `/api/chats/group/get` | 获取群组聊天列表 |
| POST | `/api/chats/group/delete` | 删除群组聊天 |

## 聊天状态

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/state/get` | 批量读取状态 |
| POST | `/api/chats/state/patch` | 增量更新状态 |
| POST | `/api/chats/state/delete` | 删除状态 |

## 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/settings/save` | 保存设置（patch-first） |
| POST | `/api/settings/get` | 获取设置 |

## 世界书

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/worldinfo/save` | 保存世界书（patch-first） |
| POST | `/api/worldinfo/get` | 获取世界书 |

## 搜索/访问

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/plugins/search/search` | 执行搜索 |
| POST | `/api/plugins/search/visit` | 访问 URL 并提取内容 |

## Patch 操作格式

消息 patch 使用 RFC 6902 JSON Patch 格式：

```json
[
  { "op": "replace", "path": "/4/mes", "value": "新内容" },
  { "op": "add", "path": "/4/extra/note", "value": "备注" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

对象 patch（`meta/patch`、`state/patch`、`settings/patch`、`worldinfo/patch`）也使用相同的 RFC 6902 格式。

## Patch 冲突与完整性语义

- 服务端会验证 patch 操作的路径是否存在
- `replace` 操作要求目标路径已存在
- `add` 操作会创建不存在的路径
- 冲突时返回错误，客户端应重试或回退到全量保存

## Chat-Completions 请求体

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

`secret_id` 字段允许在请求级别覆盖使用的 API 密钥，适用于多 Agent 编排等需要不同密钥的场景。
