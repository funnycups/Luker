# 角色卡编辑助手

角色卡编辑助手（Character Editor Assistant，简称 CEA）是 Luker 内置的 AI 辅助编辑工具。它让你可以用自然语言指令修改角色卡设定、世界书条目和 CardApp 代码，每次 AI 做出的修改都会以差异对比的形式展示，由你逐项审批后才会生效——确保角色卡始终在你的掌控之中。

编辑助手会根据当前角色卡是否含 CardApp 自动选择两种模式：

| 模式 | 适用场景 | 详细文档 |
| --- | --- | --- |
| **普通弹窗** | 不含 CardApp 的常规角色卡 | [普通弹窗模式](/zh-CN/features/card-editor/popup) |
| **CardApp Studio** | 内嵌了 CardApp 的角色卡 | [CardApp Studio](/zh-CN/features/card-editor/studio) |

## 公共能力

无论哪种模式，编辑助手都提供以下核心能力：

- **AI 工具调用驱动** — 用自然语言描述需求，AI 通过结构化的工具调用真正落到字段 / 文件上
- **差异审批** — 每一处修改都先以 diff 形式呈现，逐项 / 整批批准或拒绝，未批准的不生效
- **逐行 side-by-side 视图** — 字段级 diff 可放大查看完整的逐行对比
- **会话持久化** — 多个编辑会话独立保存，关闭后再打开能继续之前的工作和待审批 diff
- **修改历史与回滚** — 已批准的修改记入历史，可随时回滚到任意版本（Studio 用 Git 记录文件级历史）

## 入口与两种模式的切换

入口在**扩展面板 → 角色卡编辑助手**。当前角色不含 CardApp 时，「打开编辑器」打开普通弹窗；含 CardApp 时自动进入 Studio。Studio 也可以通过同面板里的「&lt;/&gt; CardApp Studio」按钮主动启动。

![编辑助手在扩展面板的入口与配置](/images/card-editor-popup/cea-extensions-panel.png)

## 配置选项

两种模式共享扩展面板里的同一组设置：

- **世界书同步弹窗** — 是否在替换 / 更新角色卡后启用世界书同步弹窗（仅普通弹窗会触发，详见[普通弹窗模式](/zh-CN/features/card-editor/popup#世界书同步)）
- **模型请求 LLM 预设** — 编辑助手使用的提示词预设（留空则使用当前预设）
- **模型请求 API 预设** — 编辑助手使用的 API 连接配置（留空则使用当前配置）
- **工具调用重试次数** — AI 返回无效工具调用时的重试次数

## 修改历史

修改历史在扩展面板里独立呈现。所有通过 AI 执行并批准的修改都会记录在这里——支持查看 diff、回滚、删除单条或清空全部历史。Studio 模式下文件变更走 Git，每条记录对应一个 commit，详见[CardApp Studio](/zh-CN/features/card-editor/studio#版本历史git)。

## 相关页面

- [普通弹窗模式](/zh-CN/features/card-editor/popup) — 不含 CardApp 的角色卡的 AI 编辑流程
- [CardApp Studio](/zh-CN/features/card-editor/studio) — 含 CardApp 的角色卡的完整开发环境
- [CardApp](/zh-CN/features/cardapp) — 角色卡内嵌应用系统
- [搜索插件](/zh-CN/features/search-tools) — Studio / 编辑助手中的联网搜索
