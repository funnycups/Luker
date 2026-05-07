# 普通弹窗模式

对于不包含 CardApp 的常规角色卡，「打开编辑器」会以弹窗形式打开 AI 对话面板。你可以在弹窗里用自然语言描述想要的修改，AI 通过工具调用自动完成，每一步都给你 diff 审批权。

::: tip 含 CardApp 的角色卡走 Studio
对于在 `data.extensions.card_app` 中内嵌了 CardApp 的角色卡，「打开编辑器」会自动进入功能更完整的 [CardApp Studio](/zh-CN/features/card-editor/studio)，而非本页描述的弹窗。
:::

## 弹窗布局

弹窗顶部展示当前角色名和绑定的主世界书；中间是与 AI 的对话区；底部是输入框、发送 / 终止按钮，以及可折叠的「对话历史」面板。

![编辑弹窗的初始空白状态](/images/card-editor-popup/cea-popup-overview.png)

## 支持的操作

弹窗中的 AI 可以通过工具调用执行以下操作：

- **修改角色卡字段** — 名称、描述、性格、场景、首条消息、示例对话、系统提示词、越权提示词、创作者备注等
- **管理世界书条目** — 创建、更新、删除世界书条目
- **查询世界书** — 按关键词搜索条目、按激活条件查询、获取条目详情
- **设置主世界书** — 更换角色卡绑定的主世界书
- **模拟 Prompt** — 预览当前设定下实际发送给模型的 prompt 结构

## 差异审批

AI 每次执行修改后，系统会在 pending 区按字段展示修改前后的差异，等待你审批：

![待审批 diff（按字段分行）](/images/card-editor-popup/cea-popup-diff-approval.png)

每个字段的差异右上角有放大图标，点开后是逐行的 side-by-side 视图，方便检查长文本（如世界书 content）的具体改动：

![放大查看：逐行 side-by-side diff](/images/card-editor-popup/cea-popup-line-diff-zoom.png)

整轮变更下方提供「批准本批次」「拒绝本批次」按钮，你也可以对单个 diff 单独操作：

![批准 / 拒绝按钮](/images/card-editor-popup/cea-popup-diff-actions.png)

只有你明确批准的修改才会生效，拒绝的修改会被丢弃。已批准的字段被记入修改历史，可以随时回滚。

## 会话管理

弹窗底部「对话历史」展开后是当前角色下的所有编辑会话：

![对话历史：多个会话并列](/images/card-editor-popup/cea-popup-sessions.png)

- 创建、切换、删除会话；上一个会话被 AI 自动取了首句作为标题
- 每个角色最多保留 **24** 个会话，超出后最早的会话被自动清理
- 会话内容持久化保存，关闭弹窗后重新打开不会丢失，待审批的 diff 也会跟回来

## 世界书同步

当你通过替换或更新操作导入新的角色卡时，如果新旧角色卡绑定了不同的世界书，编辑助手会弹出世界书同步弹窗，提供三种处理方式：

![世界书同步弹窗：三种处理方式](/images/card-editor-popup/cea-lorebook-sync.png)

- **模型分析后更新** — AI 分析新旧世界书的差异，智能合并
- **直接替换** — 用新世界书完全替换旧世界书
- **不替换** — 保留原有世界书不变

是否启用同步弹窗由扩展面板上的「替换 / 更新角色卡后启用世界书同步弹窗」开关控制。

## 相关页面

- [角色卡编辑助手概览](/zh-CN/features/card-editor/) — 公共能力与入口
- [CardApp Studio](/zh-CN/features/card-editor/studio) — 含 CardApp 角色卡的完整开发环境
- [搜索插件](/zh-CN/features/search-tools) — 弹窗中的联网搜索能力
- [状态系统](/zh-CN/features/state-system) — 角色状态和聊天状态
