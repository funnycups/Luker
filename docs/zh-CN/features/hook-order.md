# 钩子执行排序

多个扩展可以注册同一个事件钩子，例如消息生成前与消息生成后。钩子执行排序用于指定这些扩展的执行顺序。

## 为什么需要排序

### 扩展之间的依赖关系

多个扩展监听同一个事件时，执行顺序决定最终结果。例如：

- 翻译扩展处理用户输入，内容过滤扩展检查结果：翻译在过滤之前执行。
- 提示词格式化扩展与上下文扩展同时运行：格式化在添加上下文之后执行。
- [记忆图](/zh-CN/features/memory-graph)在[多 Agent 编排](/zh-CN/features/orchestrator/)之前完成记忆检索。

### 第三方扩展兼容

第三方扩展同样出现在排序列表中，可与内置扩展一起调整顺序。

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

上图对应面板中「世界书扫描后」事件的排序：记忆图排在搜索插件之前，因此记忆检索先执行，搜索结果随后写入。本轮的记忆检索读不到搜索插件当轮写入的世界书条目；若要让它参与本轮检索，把搜索插件移到记忆图之前。

## 排序界面元素

- **事件分组** —— 每个事件（如 `generation_before_world_info_scan`、`generation_after_world_info_scan`）独立维护一份排序，互不影响
- **上移 / 下移** —— 调整该事件下扩展的执行顺序
- **重置为检测到的顺序** —— 按代码扫描到的注册顺序恢复

## 保存

排序保存在设置中，重启后按上次配置恢复。

## 相关功能

- [多 Agent 编排](/zh-CN/features/orchestrator/) —— 编排器的多个 Agent 节点也有执行顺序
- [记忆图](/zh-CN/features/memory-graph) —— 记忆检索的时机受钩子顺序影响
