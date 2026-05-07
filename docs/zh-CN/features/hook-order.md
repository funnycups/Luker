# 钩子执行排序

钩子执行排序（Hook Order）允许用户自定义扩展的执行优先级。在 SillyTavern 的扩展系统中，多个扩展可以注册同一个事件钩子（如消息生成前、消息生成后等），Hook Order 让你控制这些钩子的执行顺序。

该功能作为内置扩展提供。

## 为什么需要排序

### 扩展之间的依赖关系

当多个扩展同时监听同一个事件时，它们的执行顺序可能会影响最终结果。例如：

- 一个扩展负责翻译用户输入，另一个扩展负责内容过滤——翻译应该在过滤之前执行
- 一个扩展修改提示词格式，另一个扩展添加额外上下文——格式化应该在添加上下文之后执行
- [记忆图](/zh-CN/features/memory-graph)需要在[多Agent编排](/zh-CN/features/orchestrator/)之前完成记忆检索

如果没有明确的执行顺序控制，扩展之间的交互可能产生不可预期的结果。

### 第三方扩展兼容

Hook Order 支持第三方扩展的 ID 识别，你可以将第三方扩展纳入排序管理，确保它们与内置扩展之间的执行顺序符合预期。

## 上下移动排序界面

Hook Order 在扩展面板里按事件类型分组展示，每个扩展有上移 / 下移按钮，列表顶部的扩展先执行：

![Hook 顺序面板](/images/hook-order/hook-order-panel.png)

```d2
direction: right

EVT: "generation_after_world_info_scan 触发"
H1: "memory-graph 完成记忆检索" {
  style.fill: "#e1f5ff"
}
H2: "search-tools 写入搜索结果到世界书" {
  style.fill: "#fff3e0"
}
NEXT: "继续下一阶段"

EVT -> H1 -> H2 -> NEXT
```

上图就是面板里 `世界书扫描后` 那一组——`memory-graph` 排在 `search-tools` 之前，意味着记忆检索先跑、搜索结果后写入。这一轮的记忆检索看不到 `search-tools` 当轮新写入的世界书条目；如果你希望搜索结果参与本轮的记忆检索，把 `search-tools` 上移到 `memory-graph` 之前即可。

## 排序界面元素

- **事件分组** — 每个事件（如 `generation_before_world_info_scan`、`generation_after_world_info_scan`）独立维护一份排序，互不影响
- **上移 / 下移** — 调整该事件下扩展的执行顺序
- **重置为检测到的顺序** — 按代码扫描到的注册顺序恢复

## 配置持久化

排序配置会持久化保存到设置中。重启应用后，扩展的执行顺序会按照你上次配置的顺序恢复，无需重复设置。

## 相关功能

- [多Agent编排](/zh-CN/features/orchestrator/) — 编排器的多个 Agent 节点也有执行顺序
- [记忆图](/zh-CN/features/memory-graph) — 记忆检索的时机受钩子顺序影响
