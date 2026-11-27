# Skill 管理

**工作台 → 编排 → 准备阶段**中的**管理技能...**按钮会打开 Skill 管理弹窗，用于安装、编辑、迁移与删除 Skill。本页逐个说明入口。

::: tip 在哪里找
打开**工作台 → 编排 → 准备阶段**，点击**管理技能...**；也可点击**扩展 → 聊天补全预设助手 → 将 Skills 打包到此预设**直接定位到当前预设的作用域。
:::

## 子面板概览

Skill 管理顶部包含标签页，并在**已安装**工具栏中提供导入入口：

- **已安装** —— 当前工作区内已安装的 Skill，可按作用域筛选或查看**全部作用域**。
- **浏览 Luker 内置 Skills** —— Luker 内置的 Skill，每行显示本地副本为一致、存在差异或未安装。
- **导入工具栏** —— 通过**导入 Luker 内置 Skills**、**从文件导入……**或**从链接导入……**安装 Skill。

![Skill 管理子面板，已安装标签页](/images/skills/manager-installed-tab.png)

## 已安装

每行显示：

- `name` —— Skill frontmatter 里的 `name`。点击打开内嵌编辑器。
- `description` —— frontmatter 里的一行摘要。
- **作用域** —— 作用域标记，标示该 Skill 所属的全局、聊天补全预设、编排预设或角色作用域。
- `size` —— 文件数 + 总字节数。
- **被引用** —— 当前编排配置中引用该 Skill 的 agent 数量。

右侧行内操作：

| 操作 | 作用 |
|---|---|
| **查看** | 以只读 Markdown 渲染 `SKILL.md`。 |
| **编辑** | 打开内嵌编辑器，详见下文[内嵌编辑器](#内嵌编辑器)。 |
| **移动到……** | 跨作用域原子移动，仅按名称保存的引用保持有效。 |
| **重命名** | 在当前作用域内原子重命名，同步更新目录与 frontmatter `name`，指向旧名的引用变为灰色，详见[失效引用](#失效引用)。 |
| **删除** | 删除 Skill 目录，引用变为灰色，派遣照常执行。 |

## 浏览 Luker 内置 Skills

**浏览 Luker 内置 Skills** 将本地副本与内置版本对比，每行显示以下状态：

| 标记 | 含义 |
|---|---|
| **已安装** | 本地副本与内置版本逐字节一致。 |
| **内容不同** | 本地副本存在且内容与内置版本不同。 |
| **未安装** | 本地尚无副本，点击**安装此 Skill** 安装到 `global` 作用域。 |

![浏览 Luker 内置 Skills，混合状态](/images/skills/manager-bundled-tab.png)

顶部的**安装全部内置 Skills** 按钮会安装全部内置 Skill，并以内置版本覆盖内容不同的本地副本。

::: warning 覆盖操作不可合并
**安装全部内置 Skills** 会直接覆盖同名本地副本。本地修改过 `event-summary-rules-zh` 时，安装内置版本会替换本地修改。
:::

## 导入

入口说明：

### 从文件导入……

上传包含单个 Skill 目录的 `.zip` 存档或 `SKILL.md` 文件。服务端校验文件并预览每个 Skill 的冲突状态，待逐项确认后再提交写入。

### 从链接导入……

粘贴指向原始 `SKILL.md` 或 zip 压缩包的 `https://...` 链接即可导入。本地多文件 Skill 请使用**从文件导入……**。

### 导入 Luker 内置 Skills

与**浏览 Luker 内置 Skills** 中的**安装全部内置 Skills** 对应，位于**已安装**工具栏中以便直接操作。

## 内嵌编辑器

点击 Skill 行的**编辑**可打开弹窗内嵌编辑器：

![内嵌 Skill 编辑器](/images/skills/skill-editor.png)

- 左栏：文件树，列出 `SKILL.md` 及全部子文件，点击可切换。
- 右栏：Markdown 编辑器，支持 YAML frontmatter 高亮。
- 顶栏：显示文件路径、未保存标记、**保存**按钮与 **+ 新建文件**按钮。

保存时均先校验路径安全、体积限制与 frontmatter 语法，全部通过后再原子替换原文件。

`SKILL.md` 可在编辑器中修改，不可从编辑器删除；删除整个 Skill 请使用行内**删除**操作。

::: tip 用 AI 编辑 Skill
[编排 AI 迭代](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill) 也能编写与修改 Skill，直接描述变更即可通过相同安装路径起草，适用于新建或改写已有 Skill。
:::

## 嵌入导出 —— 到预设和角色卡

Skill 与依赖它的预设或角色卡一同分发时最有价值。导出预设或角色卡时，Luker 会询问是否将对应的 Skill 一并附带进导出文件。

仅当选择**包含**时，导出文件才附带 Skill。选择**跳过**、因没有需要附带的 Skill 而未出现询问，或 Skill 附带失败时，导出文件均不附带 Skill，导入时附带 Skill 的预设或角色卡同样如此。

### 导出聊天补全预设

导出的聊天补全预设在其预设作用域中存在 Skill 时，Luker 询问「导出时一并附带此预设作用域的 Skills 吗？」。选择**包含**会将这些 Skill 附带进导出的 JSON；选择**跳过**则导出不含 Skill 的预设。

聊天补全预设助手的**将 Skills 打包到此预设**按钮会打开已筛选到当前预设作用域的 Skill 管理器，便于查看或补充此次导出附带的 Skill。

### 导出编排预设

导出编排预设时，若预设中任一 agent 可见 Skill，Luker 询问「导出时一并附带此编排预设当前激活的所有 Skills 吗？」。选择**包含**会附带来自全局、聊天补全预设与编排预设作用域的全部可见 Skill；角色作用域的 Skill 不会附带。

### 导出角色卡

角色在其角色作用域中存在 Skill 时，通过**导出并下载**导出角色卡，Luker 会在 PNG 或 JSON 文件下载前询问「导出时一并附带此角色的 Skills 吗？」。选择**包含**会将这些 Skill 附带进导出文件。角色卡绑定预设中附带的 Skill 不会导出。Skill 附带失败时，角色卡照常导出但不含 Skill，并显示警告提示。

### 安装附带的 Skill

首次打开导入的、附带 Skill 的角色卡时，以及导入附带 Skill 的聊天补全预设或编排预设时，Luker 显示安装对话框：

![嵌入导入预览：冲突处理](/images/skills/skill-conflict-replace-dialog.png)

对话框逐项列出附带的 Skill 及其冲突状态。存在冲突的条目可选择**跳过**以保留本地版本，或选择**替换**以采用文件中的版本。与已安装 Skill 内容相同的条目会跳过，新条目直接安装。点击**安装**后，Skill 写入角色卡或预设对应的作用域：

- 角色卡 → 角色作用域，包含角色卡绑定预设中附带的 Skill
- 聊天补全预设 → 聊天补全预设作用域
- 编排预设 → 编排预设作用域

该对话框对同一角色卡或预设仅显示一次。

## 作用域迁移

通过行内操作**移动到……**，可将 Skill 在 `global`、`preset` 与 `character` 之间自由移动。移动为原子文件系统重命名，不产生拷贝或中间状态。

编排配置仅按**名称**引用 Skill，不附带作用域前缀。名为 `voice-rules` 的 Skill 无论位于哪个作用域，均按 character、preset、global 的优先级顺序解析。移动作用域不改变引用，只调整 Skill 的可见范围。

典型迁移：

- **`global` → `character`** —— 为特定角色卡制作专属变体时，将变体移入该角色作用域，通用版本保留在 `global`，加载该角色卡时自动以角色作用域版本优先。
- **`preset` → `global`** —— 将仅打包在单个预设中的 Skill 提升到全局作用域以供复用。
- **`character` → `global`** —— 将角色卡专属 Skill 提升为全局通用 Skill。

## 失效引用

重命名或删除已被编排配置引用的 Skill 后，引用列表保留旧名称。运行时未找到对应 Skill 时，agent 跳过加载该 Skill，派遣照常执行。

在**工作台 → 编排 → 准备阶段**中，失效引用显示为灰色，并提示**「当前数据目录未安装此 Skill。」**。可在编排配置中更新名称，或重新添加对应 Skill。

缺失 Skill 不阻断 agent 派遣；增删 Skill 无需同步修改编排配置。

## 相关

- [Skills 概览](/zh-CN/features/skills/) —— 介绍 Skill 的定义与作用域
- [创作 Skill](/zh-CN/features/skills/authoring) —— 编写自定义 Skill
- [多智能体编排集成](/zh-CN/features/skills/orchestrator-integration) —— 在编排配置中绑定 Skill
- [Skill 扩展 API](/zh-CN/development/extension-api/skills) —— 通过扩展编程管理 Skill
- [聊天补全预设助手](/zh-CN/features/preset-assistant) —— 派生 `-orchestrator` 预设并打开对应预设作用域的 Skill 管理弹窗
