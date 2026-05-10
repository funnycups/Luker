# CardApp

CardApp 是 Luker 独有的角色卡内嵌应用系统。它允许角色卡在 `data.extensions.card_app` 中定义小型应用（包含 HTML、JavaScript 和样式），这些应用会在聊天界面中加载和渲染，为角色卡赋予交互式的动态能力。

::: tip 开发 CardApp
推荐使用 [CardApp Studio](/zh-CN/features/card-editor/studio) 来开发和调试 CardApp。Studio 提供了 CodeMirror 6 代码编辑器、实时预览和 AI 辅助开发。完整的 API 参考和开发指南请参阅[角色卡开发者指南](/zh-CN/development/card-developers)。
:::

::: tip 想看完整 walkthrough?
[从零写一个 CardApp](/zh-CN/features/card-editor/walkthrough/) 用一个轻小说西式异世界冒险题材的角色卡，演示从空角色卡到能跑的 CardApp 的全过程，含提示词实践小抄和图像生成进阶。
:::

## 生命周期

1. **挂载** — 角色切换时，系统从角色卡提取应用定义，将应用挂载到聊天界面的 UI 容器，并调用应用的 `init(ctx)` 函数
2. **运行** — 应用通过 `ctx` 上下文对象与 Luker 交互，响应聊天事件并更新自身状态
3. **卸载** — 切换到其他角色或关闭聊天时，系统清理应用实例，自动释放所有通过 `ctx` 注册的计时器、事件监听器和 dispose 回调

## 使用场景

- **角色卡内嵌互动元素** — 状态面板、情绪指示器、自定义按钮等
- **小游戏** — 文字冒险选择界面、骰子投掷器、卡牌游戏组件等
- **状态追踪** — 通过聊天变量(`ctx.getVariable` / `ctx.setVariable`)持久化好感度、任务进度、物品清单等数据;只有当数据是 CardApp 独占、不适合放进单个变量的结构化命名空间时,才用聊天状态(`ctx.getChatState` / `ctx.updateChatState`)。

## 相关页面

- [角色卡编辑助手](/zh-CN/features/card-editor/) — 含 CardApp 角色卡的编辑入口（自动进入 Studio）
- [CardApp Studio](/zh-CN/features/card-editor/studio) — 开发和调试 CardApp 的完整环境
- [角色卡开发者指南](/zh-CN/development/card-developers) — 完整的 CardApp API 参考和开发文档
- [状态系统](/zh-CN/features/state-system) — 角色状态和聊天状态
