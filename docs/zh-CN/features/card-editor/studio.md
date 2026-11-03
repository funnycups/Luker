# CardApp Studio

CardApp Studio 是角色卡编辑助手的完整开发环境，专为内嵌了 [CardApp](/zh-CN/features/cardapp) 的角色卡设计。它提供代码编辑器、实时预览、AI 辅助开发和版本历史，是开发和调试 CardApp 的推荐工作台。

::: tip 首次使用 Studio
请先阅读[从零写一个 CardApp](/zh-CN/features/card-editor/walkthrough/)。该教程用一个示例角色卡完整执行工作流，并包含提示词实践要点。本页说明 Studio 的能力，教程提供从零执行的实战路径。
:::

## 打开方式

两条路径均会进入 Studio：

1. **扩展面板 → 角色卡编辑助手 → 「&lt;/&gt; CardApp Studio」按钮**
2. 当前角色含 CardApp 时，**「打开编辑器」会直接进入 Studio**；不含 CardApp 的角色卡进入[普通弹窗](/zh-CN/features/card-editor/popup)

## 界面布局

Studio 采用三栏布局，覆盖在 Luker 主界面之上：

![Studio 三栏总览：左侧 AI 对话 / 中间实时预览 / 右侧代码编辑器](/images/cardapp-studio/studio-overview.png)

- **左侧面板** —— AI 对话区域，用自然语言描述需求，由 AI 修改文件
- **中间区域** —— 实时聊天界面与 CardApp 预览，修改后可直接验证效果
- **右侧面板** —— 代码编辑器与文件列表

### 左侧：AI 对话与会话

左侧是 Studio 的 AI 助手对话区。所有对 CardApp 的修改均从这里发起：

![Studio AI 助手对话区](/images/cardapp-studio/studio-ai-chat.png)

顶部的「会话」按钮展开后是当前角色下的所有 Studio 会话，可以创建 / 切换 / 删除：

![Studio 会话面板](/images/cardapp-studio/studio-sessions.png)

### 中间：CardApp 实时预览

中间区域是 SillyTavern 自身的聊天界面，CardApp 在其中实时渲染。批准 AI 的文件修改后，预览自动重载：

![中间面板：abyss-walker CardApp 实时运行](/images/cardapp-studio/studio-preview.png)

上图为示例角色「深渊行者」的 CardApp：状态栏、动作按钮与自定义行动输入框均由 CardApp 渲染。

### 右侧：代码编辑器、文件树、版本历史

右侧合并了三块：

![右侧面板：代码编辑器、文件列表、版本历史](/images/cardapp-studio/studio-code-editor.png)

- 顶部 **代码编辑器** —— 自动按文件类型语法高亮（HTML / JS / CSS / JSON 等）；保存和重载按钮在右上
- 中部 **文件列表** —— 列出 CardApp 所有文件并显示尺寸；点击切换编辑目标
- 底部 **修改历史** —— 版本记录列表，每条显示版本标识、说明、时间和回滚按钮

## 支持的操作

Studio 中的 AI 具备比普通弹窗更完整的能力，包括以下几类：

**CardApp 文件操作：**
- 列出所有文件
- 读取文件内容
- 创建或覆写文件
- 补丁式修改文件（查找替换）
- 删除文件
- 重命名 / 移动文件
- 启用或停用 CardApp

**角色卡字段操作：**
- 读取所有可编辑字段
- 更新一个或多个字段

**世界书操作：**
- 列出可见世界书，并标注其作用域：角色卡、聊天或全局
- 获取/创建/更新/删除/全量替换某本书内的条目
- 列出、替换、创建并绑定聊天专用世界书

**正则脚本操作** —— 列出、创建、更新、删除角色卡级或全局正则脚本。

**角色级编排器覆盖** —— 读取、替换、清空当前角色卡上的编排器覆盖，范围限于当前角色卡。

**角色级记忆图覆盖** —— 读取当前生效的记忆图配置，替换节点类型，或调整高级设置，范围限于当前角色卡。

**查询辅助** —— Studio 可以查询斜杠命令、运行时接口和本站文档，在生成代码前核对名称与用法。

::: tip CardApp 创作约定
按 Luker 的 CardApp 创作约定，所有 AI 可见内容放在绑定的世界书里。Studio 默认遵守这一约定。详见[角色卡开发者指南](/zh-CN/development/card-developers)。
:::

## 代码编辑器细节

右侧代码编辑器的能力：

- **语法高亮** —— 自动按文件扩展名识别（HTML / JS / CSS / JSON 等）
- **多文件切换** —— 顶部 Tab 形式管理已打开的文件
- **新建文件** / **保存** / **重载**
- **手动修改同样记录** —— 你直接编辑的内容也进入版本历史

## 文件变更审批

AI 对文件的每次修改均需要审批。与普通弹窗一样，界面会显示完整的改动内容和逐行对照，可以单项批准或批量批准。批准后写入文件。

## 会话管理

- 多个开发会话，可创建 / 切换 / 删除
- 每个角色最多保留 **20** 个会话
- 会话保存在角色状态中，关闭 Studio 后重新打开可继续

## 版本历史 {#version-history-git}

Studio 自动记录文件的版本历史：

- 每次审批通过的变更会生成一条版本记录
- 支持查看历史版本的改动内容
- 支持回滚到任意历史版本
- 与角色卡数据一起导出，分享后接收方可查看完整开发历程

::: info 数据位置
版本记录保存在 Luker 的扩展数据中，不写入角色卡的标准字段。CardApp 依赖 Luker 的运行时，导出到 SillyTavern 后无法运行。
:::

## 与搜索插件集成

Studio 已集成[搜索插件](/zh-CN/features/search-tools)的能力，AI 可在开发过程中联网查询资料，并把结果用于生成代码。搜索插件可用时即可使用。

## 相关页面

- [角色卡编辑助手概览](/zh-CN/features/card-editor/) —— 公共能力与入口
- [普通弹窗模式](/zh-CN/features/card-editor/popup) —— 不含 CardApp 的角色卡的 AI 编辑流程
- [CardApp](/zh-CN/features/cardapp) —— 角色卡应用化概念
- [角色卡开发者指南](/zh-CN/development/card-developers) —— CardApp API 参考与创作约定
