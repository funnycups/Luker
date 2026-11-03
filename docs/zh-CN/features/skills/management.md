# Skill 管理

编排器面板的**管理 Skills**按钮打开一个子面板，用于安装、编辑、迁移与删除 Skill。本页逐个说明入口。

::: tip 在哪里找
打开扩展抽屉 → **多 Agent 编排** 节 → 点面板底部附近的**管理 Skills**。子面板以弹窗形式覆盖在编排器配置之上。
:::

## 子面板概览

Skill 管理顶部有多个标签页：

- **已安装** —— 本地安装的 Skill。按作用域筛选，可选全局、预设、角色卡或全部。
- **浏览出厂** —— Luker 自带的 Skill，每行显示本地副本与内置版本一致、有差异或尚未安装。
- **导入** —— 从文件、URL、角色卡或预设中提取 Skill。

![Skill 管理子面板，已安装标签页](/images/skills/manager-installed-tab.png)

## 已安装

每行显示：

- `name` —— Skill frontmatter 里的 `name`。点击打开内嵌编辑器。
- `description` —— frontmatter 里的一行摘要。
- `scope` —— 作用域标记，取值为 `global`、`preset/<api>/<name>` 或 `character/<file>`。
- `size` —— 文件数 + 总字节数。
- **被引用** —— 当前编排器配置中引用该 Skill 的 agent 数量。

行内动作（右侧）：

| 动作 | 作用 |
|---|---|
| **查看** | `SKILL.md` 的只读 Markdown 渲染。 |
| **编辑** | 打开内嵌编辑器（见下文 [内嵌编辑器](#内嵌编辑器)）。 |
| **迁移到……** | 原子级跨作用域 move。引用（仅按名字）依然有效。 |
| **改名** | 在当前作用域内原子改名。目录与 frontmatter `name` 同步更新。指向旧名的引用变灰（见 [失效引用](#失效引用)）。 |
| **删除** | 删除 Skill 目录。引用显示为灰色，派遣照常进行。 |

### 批量选择

顶栏切到**多选**模式后，每行多一个复选框。勾选至少一项后，工具栏会出现一个**把所选打包进预设……**动作 —— 见下文 [嵌入导出](#嵌入导出-到预设和角色卡)。

## 浏览出厂

「浏览出厂」把你本地每个出厂 Skill 的副本与内置版本对比。每行显示以下状态之一：

| 标记 | 含义 |
|---|---|
| **已安装（一致）** | 本地副本与出厂版本逐字节一致。 |
| **已安装（你的版本有差异）** | 本地副本存在，但哈希与出厂版本不匹配 —— 你（或某次迭代工作台会话）改过它。 |
| **未安装** | 本地没有副本。点击**安装**将其装入 `global` 作用域。 |

![浏览出厂，混合状态](/images/skills/manager-bundled-tab.png)

顶部的**全量导入出厂**按钮相当于对每个「未安装」或「有差异」的行选择**安装**，会用出厂版本覆盖所有出厂 Skill。

::: warning 覆盖是破坏性的
全量导入出厂不会合并 —— 它直接覆盖。如果你本地改过 `event-summary-rules-zh`，导入出厂版本会冲掉你的修改。按钮标签会在点击前明确告诉你即将覆盖多少个同名 Skill。
:::

## 导入

入口：

### 从文件导入

上传一个包含单个 Skill 目录的 `.zip`。服务端校验存档，预览每个 Skill 的冲突状态（每 Skill：`新` / `相同` / `不同`），然后等你对每个冲突做决定再提交。

### 从 URL 导入

粘贴一条 `https://...` URL，指向一份原始 `SKILL.md`。服务端下载后作为单文件 Skill 安装（无子文件）。多文件 Skill 请使用**从文件导入**的 zip 路径。

::: info 只接受 HTTPS、只接受原始 SKILL.md
URL 导入器的范围有意保持狭窄：它只获取一份 Markdown 文件。更复杂的情况（多文件、二进制）使用 zip 导入。导入范围保持小且可预测。
:::

### 导入出厂

与「浏览出厂」中的**全量导入出厂**是同一操作，此处列出以便查找。

### 从角色卡 / 预设抽取

导入带 `embedded_skills_source` 字段的角色卡（PNG）或预设（JSON）时，Luker 会自动弹出预览对话框：

![嵌入导入预览：冲突处理](/images/skills/skill-conflict-replace-dialog.png)

对话框逐项列出每个嵌入的 Skill 及其冲突状态。对每个冲突，你可选**跳过**（保留本地版本）或**替换**（用嵌入里的版本）。内容相同的项（`相同`）会静默跳过；新条目（`新`）直接安装。

抽取后，角色卡与预设文件中的嵌入载荷被移除，Skill 内容以 `skills/character/<file>/` 或 `skills/preset/<api>/<preset>/` 下的文件为准。

## 内嵌编辑器

点击 Skill 行的**编辑**会打开弹窗内编辑器：

![内嵌 Skill 编辑器](/images/skills/skill-editor.png)

- 左栏：文件树（SKILL.md + 任何子文件）。点击切换。
- 右栏：Markdown 编辑器，frontmatter 区段有 YAML 感知高亮。
- 顶栏：文件路径、未保存标记、**保存**（通过 `.staging/` 原子提交）、**新增文件**（在指定路径创建一份新子文件）。

写入与安装使用同一套 `.staging/` 规则：新内容先经过校验（路径安全、大小限额、frontmatter 解析），全部通过后由 staging 文件原子替换原文件。失败的写入对原文件没有影响。

`SKILL.md` 是特殊的 —— 它可以编辑，但不能从编辑器中删除（它是必需入口）。Skill 本身可通过行内动作整体删除。

::: tip 用 AI 编辑 Skill
[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill) 也能替你写和修改 Skill —— 用一句话描述变更，工作台通过相同的安装路径起草。适用于新建 Skill，或改写已有 Skill。
:::

## 嵌入导出 —— 到预设和角色卡

Skill 在跟它所依赖的产物（角色卡、预设）一起分发时最有用。某张角色卡需要某条口吻规则，某个预设是为特定子代理调出来的 —— 两者均能把 Skill 内联打包。

### 打包进预设

在编排器面板中，[补全预设助手](/zh-CN/features/preset-assistant) 会派生出一份 `-orchestrator` 预设。派生完成后，助手会提供一条**为该预设打包 Skills** 链接，点击后打开 Skill 管理并自动启用多选模式。选择需要的 Skill，点击**把所选打包进预设……**，再选择目标预设。

打包器把这些 Skill 写进预设的 `extensions.luker.embedded_skills_source` 字段。下一次保存预设时，嵌入随 JSON 一起被持久化。其他 Luker 用户导入这份预设时会看到上文描述的嵌入抽取对话框。

### 打包进角色卡

在角色卡编辑器里，**出厂 Skill** 区段也是同样的逻辑：选 Skill、打包，它们写进 `data.extensions.luker.embedded_skills_source`。PNG 导出时嵌入序列化进卡的元数据，分发这张卡也就分发了 Skill。

::: tip 内联 vs zip 的阈值
仅含文本的小型 Skill 使用 `inline-files-v1` 格式（Markdown 内容直接内嵌）。较大或包含二进制的 Skill 自动升级到 `archive-base64-v1`（zip + base64 + sha256）。打包器会按每个 Skill 自动决定，无需手动选择。
:::

## 作用域迁移

通过行内动作**迁移到……**，你随时可以把 Skill 从 `global` → `preset` → `character`（或反向）移动。迁移是一次原子文件系统重命名 —— 没有拷贝，没有中间状态。

编排器配置只按**名称**引用 Skill，不带作用域前缀。名为 `voice-rules` 的 Skill 无论在哪个作用域，均按 character、preset、global 的顺序解析。迁移不改变引用，只改变 Skill 何时可见。

典型迁移：

- **`global` → `character`** —— 你写了一条写作规则、用在多张卡上，后来发现某张卡需要一份专门变体。把它迁到那张卡的作用域，让更通用的版本留在 `global`。两者共存；卡片加载时按卡的版本胜出。
- **`preset` → `global`** —— 你打包在某个预设里的 Skill 后来发现到处均有用。把它提升到全局。
- **`character` → `global`** —— 某个角色卡专属 Skill 最终泛化了。提升它。

## 失效引用

当你改名或删除某个被编排器配置引用的 Skill，引用列表保留旧名。运行时找不到它，Agent 不加载这个 Skill，派遣照常进行。

在编排器配置编辑器中，失效引用显示为灰色，并提示**「该 Skill 未安装」**。修正方式有两种：在编排配置中改名，或重新添加该 Skill。

缺失的 Skill 不阻断 Agent 派遣；增删 Skill 无需修改编排配置。

## 相关

- [Skills 概览](/zh-CN/features/skills/) —— 什么是 Skill、作用域
- [创作 Skill](/zh-CN/features/skills/authoring) —— 写自己的
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 把 Skill 挂到编排配置上
- [Skill 扩展 API](/zh-CN/development/extension-api/skills) —— 从扩展编程式管理
- [补全预设助手](/zh-CN/features/preset-assistant) —— 派生 `-orchestrator` 预设并给出打包 Skills 链接
