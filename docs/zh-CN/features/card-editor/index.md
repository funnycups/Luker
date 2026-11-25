# 角色卡编辑助手

角色卡编辑助手是 Luker 内置的 AI 辅助编辑工具，支持通过自然语言指令修改角色卡设定、世界书条目与 CardApp 代码。AI 提出的每次修改均先以差异对比展示，确认后才会生效。

角色卡字段与内嵌 CardApp 分别对应各自的工作区：

| 模式 | 适用场景 | 详细文档 |
| --- | --- | --- |
| **工作台卡片编辑** | 修改角色卡字段与绑定的世界书 | [工作台卡片编辑](/zh-CN/features/card-editor/popup) |
| **CardApp Studio** | 开发角色卡内嵌的 CardApp 应用 | [CardApp Studio](/zh-CN/features/card-editor/studio) |

## 公共能力

- **AI 工具调用驱动** —— 用自然语言描述需求，AI 通过结构化的工具调用生成字段与文件改动提案
- **差异审阅** —— 每处修改先进入**改动清单**展示前后差异，勾选后应用或放弃
- **逐行差异展开** —— 字段级差异可展开查看完整的逐行对比
- **会话持久化** —— 同一角色下的多个编辑会话独立保存，重新打开后可继续先前的讨论与待审改动
- **改动记录与撤销** —— 已应用的卡片与世界书修改记入**工作台 → 改动记录**支持逐条撤销；Studio 模式下文件变更通过 Git 提交记录版本

## 入口说明

- **工作台 → AI 迭代** —— 选择**角色卡**或**世界书**目标，在统一的[工作台](/zh-CN/features/workbench)中对话修改当前角色卡及绑定的世界书，右侧实时预览卡片内容。
- **扩展 → 角色卡编辑助手** —— **打开编辑器**直接跳转到当前角色的**工作台 → AI 迭代 → 角色卡**，**&lt;/&gt; CardApp Studio** 打开面向 CardApp 的多栏开发环境。

![编辑助手在扩展面板的入口与配置](/images/card-editor-popup/cea-extensions-panel.png)

## 配置选项

可在**工作台 → 设置**统一配置默认连接与生成预设，也可在**扩展 → 角色卡编辑助手**单独指定：

- **迭代 AI 的提示词预设** —— 编辑助手与 CardApp Studio 使用的提示词预设；留空时跟随工作台共用设置或当前预设。下拉框下方的操作可导入内置的 `plugin-only` 示例，或打开预设工作台从现有预设派生
- **迭代 AI 的 API 预设** —— 编辑助手与 CardApp Studio 使用的 API 连接配置
- **工具调用重试次数** —— AI 返回无效工具调用时的重试次数
- **自定义系统提示词（高级）** —— 分别改写「编辑器迭代提示词」与「CardApp Studio 提示词」

## 修改历史

在工作台应用的卡片与世界书改动可在**工作台 → 改动记录**中按目标筛选并逐条撤销，扩展面板内的**历史**区域同样保留操作记录。CardApp Studio 下的代码版本历史见 [CardApp Studio](/zh-CN/features/card-editor/studio#version-history-git)。

## 相关页面

- [工作台卡片编辑](/zh-CN/features/card-editor/popup) —— 角色卡字段编辑与替换角色卡时的世界书合并
- [CardApp Studio](/zh-CN/features/card-editor/studio) —— 含 CardApp 角色卡的完整开发环境
- [CardApp](/zh-CN/features/cardapp) —— 角色卡内嵌应用系统
- [搜索工具](/zh-CN/features/search-tools) —— Studio 与工作台 AI 迭代中的联网搜索
