# CardApp

CardApp 是随角色卡加载的小应用，把状态面板、互动按钮、小游戏与剧情选项直接显示在聊天界面中。CardApp 属于角色卡：切换到该角色时加载，离开时卸载，不影响其他角色。

## 能做什么

- **状态面板**：显示好感度、体力、任务进度、物品清单等随剧情变化的数据。
- **互动按钮**：用符合角色设定的按钮替代通用工具栏。
- **小游戏**：文字冒险选项、骰子、卡牌等轻量玩法。
- **自定义界面**：以与世界观一致的布局、配色和文案展示信息。

CardApp 的状态保存在当前聊天中，切换聊天或重新打开后保留。

## 怎么做

用 [CardApp Studio](/zh-CN/features/card-editor/studio) 开发：描述想要的效果，Studio 生成界面并写入角色卡，实时预览修改结果。完整的从零示例见[异世界生存日志](/zh-CN/features/card-editor/walkthrough/isekai)。

::: tip 开发环境
Studio 提供代码编辑器、实时预览与 AI 辅助。需要编写自定义逻辑时，接口与约定见[角色卡开发者指南](/zh-CN/development/card-developers)。
:::

## 相关页面

- [角色卡编辑助手](/zh-CN/features/card-editor/) —— 含 CardApp 角色卡的编辑入口
- [CardApp Studio](/zh-CN/features/card-editor/studio) —— 开发和调试 CardApp 的工作台
- [状态系统](/zh-CN/features/state-system) —— CardApp 的数据如何随聊天保存
