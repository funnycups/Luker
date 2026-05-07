# 后端实时存储

Luker 重新设计了数据持久化架构，将数据变更的保存职责从前端转移到后端，实现实时持久化，从根本上消除因浏览器崩溃、网络中断或意外关闭导致的数据丢失风险。

## 问题背景

在 SillyTavern 中，数据保存由前端触发：前端将完整的聊天数据序列化后发送到后端覆盖写入。这种模式存在严重的数据安全隐患：

- **浏览器崩溃** — 如果在保存请求发出前浏览器崩溃，所有未保存的修改都会丢失
- **网络中断** — 保存请求可能因网络问题失败，而前端可能不会重试
- **生成中断** — AI 生成过程中如果连接断开，已生成的内容可能无法保存
- **竞态条件** — 多个保存请求并发时可能产生数据覆盖

Luker 通过后端实时存储彻底解决了这些问题。

## 数据变更实时持久化

所有通过[增量同步](/zh-CN/improvements/incremental-sync)端点到达后端的数据变更，都会立即写入磁盘。后端不使用内存缓存或延迟写入——每次追加、修补或更新元数据操作完成后，数据已经安全地持久化到文件系统中。

写入完成后，后端更新聊天状态文件，记录新的 integrity UUID 和时间戳，确保后续操作能正确检测并发冲突。

## 聊天状态文件 {#chat-state-file}

每个聊天文件都有一个对应的状态文件，存储在与聊天文件相同的目录中。状态文件记录：

- **integrity** — 当前文件的 integrity UUID，用于[并发冲突检测](/zh-CN/improvements/incremental-sync#integrity-hash-并发冲突检测)
- **updated_at** — 最后一次写入的时间戳

状态文件与聊天文件分离存储，避免了在聊天文件中频繁更新 integrity 值导致的全文件重写。

```d2
direction: right

DIR: "chats/<角色名>/"
CHAT: "{chat}.jsonl" {
  style.fill: "#e1f5ff"
}
STATE: "{chat}.luker-state.chat_sync.json" {
  style.fill: "#fff3e0"
}
NS1: "{chat}.luker-state.memory_graph__meta.json"
NS2: "{chat}.luker-state.luker_orchestrator__schema.json"

DIR -> CHAT
DIR -> STATE
DIR -> NS1
DIR -> NS2
```

- `{chat}.jsonl` — 聊天主文件
- `{chat}.luker-state.chat_sync.json` — integrity + updated_at(同步元数据)
- `{chat}.luker-state.<namespace>.json` — 各插件的 namespace 状态(每个插件一份独立 sidecar)

如果状态文件不存在（例如从旧版本迁移的聊天），系统会自动回退处理，并在首次写入时自动创建状态文件。

## Generation Acknowledge

在 AI 生成场景中，Luker 的统一生成层实现了 Generation Acknowledge 机制。当后端完成一次生成并将结果持久化后，会在响应中确认生成结果已被服务端安全存储。

```d2
shape: sequence_diagram

FE: "前端"
BE: "后端（统一生成层）"
LLM: "上游 LLM"
Disk: "磁盘"

FE -> BE: "发起 AI 生成请求"
BE -> LLM: "转发请求"
LLM -> BE: "流式响应"
BE -> Disk: "实时持久化生成结果"
Disk -> BE: "写入完成"
BE -> FE: "返回响应 + acknowledge"
FE -> FE: "更新本地 integrity 状态"

BE."即使前端在收到 ack 后崩溃,数据已落盘"
```

这意味着即使前端在收到生成结果后立即崩溃，数据也不会丢失——因为后端已经在返回响应之前完成了持久化。前端收到确认后更新本地的 integrity 状态，保持与服务端的同步。

::: tip 与传统模式的对比
在 SillyTavern 中，AI 生成的结果先到达前端，由前端决定何时保存。如果前端在保存前崩溃，生成的内容就会丢失。Luker 的 Generation Acknowledge 将保存时机提前到了后端响应之前，从根本上消除了这个窗口期。
:::

## 序列化聊天写入 {#序列化聊天写入}

为了防止并发写入导致文件损坏，Luker 在前端（通过 `runSerializedChatWrite`）对聊天写入任务做串行化，同时由后端对每次写入执行 integrity 校验。

当多个写入操作短时间内同时触发时（例如用户快速编辑多条消息，或者生成完成与用户编辑同时发生），流程为：

1. 前端将写入任务按到达顺序排队
2. 按顺序逐个调用增量端点执行写入
3. 每次写入成功后，后端更新聊天状态 sidecar 中的 integrity UUID
4. 若排队中的请求携带过期 integrity，后端返回 `409 Conflict`

这种“前端串行 + 后端校验”的组合可以保证写入顺序与一致性，而不依赖后端内存写队列。

## 与增量同步的协作

后端实时存储与[增量同步](/zh-CN/improvements/incremental-sync)紧密配合：

- 增量同步负责「传什么」— 只传输变更的数据
- 后端实时存储负责「怎么存」— 确保数据安全持久化
- 聊天状态文件是两者的桥梁 — 通过 integrity UUID 协调前后端状态

两者共同构成了 Luker 的数据安全基础设施。

## 相关页面

- [增量同步](/zh-CN/improvements/incremental-sync) — 后端实时存储的前端配合机制
- [改进总览](/zh-CN/improvements/overview) — 所有技术改进的概述
