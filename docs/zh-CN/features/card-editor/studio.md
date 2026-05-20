# CardApp Studio

CardApp Studio 是角色卡编辑助手的完整开发环境，专为内嵌了 [CardApp](/zh-CN/features/cardapp) 的角色卡设计。它提供基于 CodeMirror 6 的代码编辑器、实时预览、AI 辅助开发，以及 Git 版本控制——是开发和调试 CardApp 的推荐工作台。

::: tip 第一次用 Studio?
看[从零写一个 CardApp](/zh-CN/features/card-editor/walkthrough/)，用一个示例角色卡完整跑通工作流，含提示词实践小抄。本页是 Studio 的能力清单，walkthrough 是从零跑通的实战路径。
:::

## 打开方式

两条路径都会进入 Studio：

1. **扩展面板 → 角色卡编辑助手 → 「&lt;/&gt; CardApp Studio」按钮**
2. 当前角色含 CardApp 时，**「打开编辑器」也会自动进入 Studio**（而非[普通弹窗](/zh-CN/features/card-editor/popup)）

## 界面布局

Studio 采用三栏布局，覆盖在 Luker 主界面之上：

![Studio 三栏总览：左侧 AI 对话 / 中间实时预览 / 右侧代码编辑器](/images/cardapp-studio/studio-overview.png)

- **左侧面板** — AI 对话区域，用自然语言描述需求，AI 通过工具调用编辑文件
- **中间区域** — 实时聊天界面 / CardApp 预览，方便边改边验证
- **右侧面板** — 基于 CodeMirror 6 的代码编辑器 + 文件树管理

### 左侧：AI 对话与会话

左侧是 Studio 的 AI 助手对话区。所有对 CardApp 的修改都从这里发起：

![Studio AI 助手对话区](/images/cardapp-studio/studio-ai-chat.png)

顶部的「会话」按钮展开后是当前角色下的所有 Studio 会话，可以创建 / 切换 / 删除：

![Studio 会话面板](/images/cardapp-studio/studio-sessions.png)

### 中间：CardApp 实时预览

中间区域就是 SillyTavern 自身的聊天界面，CardApp 在其中实时渲染。AI 改完文件并批准后，预览自动重载，立刻能看到效果：

![中间面板：abyss-walker CardApp 实时运行](/images/cardapp-studio/studio-preview.png)

上图是 demo 角色「深渊行者」的 CardApp 在运行——状态栏（HP/MP/金币）、动作按钮区（探索 / 搜索 / 战斗 / 休息 / 下层 / 背包 / 撤回 / 重生成 / 存档）、自定义行动输入框，全部由 CardApp 的 HTML/JS 渲染。

### 右侧：代码编辑器、文件树、Git 历史

右侧合并了三块：

![右侧面板：CodeMirror 编辑器、文件列表、Git 历史](/images/cardapp-studio/studio-code-editor.png)

- 顶部 **代码编辑器**（CodeMirror 6）—— 自动按文件类型语法高亮（HTML / JS / CSS / JSON 等）；保存 / 重载按钮在右上
- 中部 **文件列表** —— 列出 CardApp 所有文件并显示尺寸；点击切换编辑目标
- 底部 **修改历史** —— Git commit 列表，每条显示短 commit hash、commit message、时间和回滚按钮

## 支持的操作

Studio 中的 AI 拥有比普通弹窗更丰富的工具集，分七大类：

**CardApp 文件操作：**
- 列出所有文件
- 读取文件内容
- 创建或覆写文件
- 补丁式修改文件（查找替换）
- 删除文件
- 重命名 / 移动文件
- 切换 CardApp 启用开关（`extensions.card_app.enabled`）

**角色卡字段操作：**
- 读取所有可编辑字段
- 更新一个或多个字段

**世界书操作：**
- 列出可见世界书并标注作用域（`character` / `chat` / `global`）
- 获取/创建/更新/删除/全量替换某本书内的条目
- 列出、替换、创建+绑定 chat-bound 世界书（`chat_metadata.world_info`）

**正则脚本操作** — 列出/创建/更新/删除卡级（`character.data.extensions.regex_scripts`）或全局（`extension_settings.regex`）正则脚本。Studio AI 是这套流程里唯一会创建卡级正则脚本的入口。

**角色级编排器（orchestrator）覆盖** — 读取、替换、清空当前角色卡上的编排器覆盖。永远只作用于当前角色，不会动全局编排器设置。

**角色级记忆图覆盖** — 读取生效的记忆图配置（schema + 高级设置 + 作用域标签）、替换节点类型 schema、或对高级设置打补丁。永远只作用于当前角色。

**发现 / 文档查询** — `slashcmd_list` + `slashcmd_help` 查斜杠命令，`luker_context_list_keys` + `luker_context_describe` 查运行时 API，`list_luker_docs` + `read_luker_doc` 直接读 Markdown 文档（和本站同源）。Studio AI 用这些工具在生成代码前核对名字和签名，而不是凭记忆猜。

::: tip CardApp 创作约定
按 Luker 的 CardApp 创作约定，所有 AI 可见内容都应放在通过 `extensions.world` 绑定的世界书里，而非角色卡的 `system_prompt` / `post_history_instructions` 字段。Studio 默认遵守这一约定。详见[角色卡开发者指南](/zh-CN/development/card-developers)。
:::

## 代码编辑器细节

右侧 CodeMirror 6 编辑器的能力：

- **语法高亮** — 自动按文件扩展名识别（HTML / JS / CSS / JSON 等）
- **多文件切换** — 顶部 Tab 形式管理已打开的文件
- **新建文件** / **保存** / **重载**
- **AI 与你的编辑共存** — 你直接修改的内容也会被纳入 Git 版本管理

## 文件变更审批

AI 对文件的每次修改都需要审批，与普通弹窗相同的 diff 体验：完整文件 diff、逐行 side-by-side 对比、单项 / 批量批准。批准后变更才落到磁盘。

## 会话管理

- 多个开发会话，可创建 / 切换 / 删除
- 每个角色最多保留 **20** 个会话（普通弹窗是 24 个）
- 会话内容持久化保存在角色状态中，关闭 Studio 后重新打开不丢

## 版本历史（Git） {#version-history-git}

Studio 通过 Git 自动记录文件的版本历史：

- 每次审批通过的变更会作为一个 commit
- 支持查看历史版本的 diff
- 支持回滚到任意历史版本
- 与角色卡数据一起导出，分享后接收方仍可看到完整开发历程

::: info 与 SillyTavern 数据兼容
Studio 的 Git 仓库存储在 Luker 的扩展数据区，不会污染角色卡 V2 标准字段。导回 SillyTavern 时仅丢失版本历史，CardApp 本体仍可正常运行。
:::

## 与搜索插件集成

Studio 已集成 [搜索插件](/zh-CN/features/search-tools) 的能力，AI 可在开发过程中联网搜索资料（如 API 文档、设计参考），将结果直接用在编码上下文中。无需额外配置——只要搜索插件可用即可。

## 相关页面

- [角色卡编辑助手概览](/zh-CN/features/card-editor/) — 公共能力与入口
- [普通弹窗模式](/zh-CN/features/card-editor/popup) — 不含 CardApp 的角色卡的 AI 编辑流程
- [CardApp](/zh-CN/features/cardapp) — 角色卡应用化概念
- [角色卡开发者指南](/zh-CN/development/card-developers) — CardApp API 参考与创作约定
