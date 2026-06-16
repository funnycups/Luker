# 更新日志

> 🚧 完整的更新日志正在整理中。以下是 Luker 主要版本的功能概览。

## 当前版本

### 编排器

- **搜索工具支持正则** —— `draft_search`（新增）以及已有的 `chat_search` / `lorebook_search` / `skill_search` 都接受 `pattern` 参数（JavaScript 正则表达式源码），并返回 grep `-n` 风格输出。批评者用它系统性地扫描词汇模式，而不再依赖肉眼通读。
- 自定义工具 —— 四个编排模式都能调用三种来源的工具：手写工具、其他 Luker 扩展贡献的工具，以及桥接进来的 SillyTavern function tool。
- 手写工具跟随编排走；角色卡覆写里的工具会随角色卡一起导出。
- AI 迭代会看到这些自定义工具，并按编排开关。

### 核心功能

- **记忆图**：基于知识图谱的长期记忆系统，9 层混合召回管线
- **多Agent编排**：三种执行模式（Spec 工作流、单 Agent、Agenda 规划器）
- **角色卡编辑助手**：AI 驱动的对话式角色卡编辑，7 个工具
- **搜索插件**：DuckDuckGo、SearXNG、Brave Search 三引擎支持
- **补全预设助手**：AI 辅助预设参数理解和优化
- **CardApp**：角色卡内嵌交互式应用

### 架构改进

- **预设解耦**：连接参数与预设独立管理
- **增量同步**：RFC 6902 格式的增量数据传输
- **后端实时存储**：数据变更即时持久化
- **可选数据库后端**：通过 `storage.mode` 选择文件系统（默认）、SQLite、MySQL 或 PostgreSQL；管理面板提供 `fs ↔ sqlite` 双向迁移，并保留永久备份
- **函数调用运行时**：原生 + 纯文本两种模式
- **统一生成层**：多后端统一封装
- **请求检查器**：生成请求全生命周期追踪
- **认证与配额**：GitHub/Discord OAuth + 存储配额管理

### 用户体验

- 角色卡绑定预设与人设
- 提示词分组 & 预设分组
- 钩子执行排序
- 世界书激活链路追踪
- 聊天人设锁定
- 撤销 Toast 系统
- 动态模型列表
- 图像生成增强
- 移动端适配优化
- 启动性能优化

## 近期破坏性变更

- **搜索工具 schema 重命名** —— `chat_search`、`lorebook_search`、`skill_search` 现在接受 `pattern`（JavaScript 正则表达式源码）参数，取代原先的 `query`（子串）。旧的 `limit` / `contextLines` 参数被移除；输出为 grep `-n` 风格。任何用户自定义提示词中硬编码了 `query: "..."` 的工具调用示例，都需要改写为 `pattern: "..."`。注意：编排器侧的 `skill_search`（编排器 agent 使用）已迁移；经由 ToolManager 派发的 `skill_search`（非编排器 SillyTavern function-call agent 使用）为保持向后兼容，仍保留子串 API。

- **CardApp Studio 回滚到独立全屏 UI**（2026 年 5 月短暂上线的"接入迭代工作台外壳"版本失去了 viewport 所有权，UX 明显退化）。Studio 现在通过两块 `position:fixed` 面板再次接管 viewport，配合移动端 tab、文件树、CodeMirror 6 编辑器与对话流内联的审批卡片 —— 跟 SP-2 之前用户熟悉的 UX 一致。文件操作仍然享受 edits-lib 的漂移检测与单条 inverse —— 这是原独立版本没有的新能力。短暂期间的 session 桶（`cardapp_studio_sessions_v2`）首次打开时清空；磁盘上的 CardApp 文件不受影响。

- **edits-lib 现在支持两种集成方式**：套上 iteration-studio 外壳适配器适合弹窗形式的界面；直接用库原语适合全屏 / 自定义 UI。CardApp Studio 是直接用法的仓库内参考实现。

- **CPA 基于迭代工作台外壳重构**（适配器迁移 SP-4，Plan 2 收官）。309 行的 `dialog-ui.js` 被删除；CPA 既有的 IDE 风格业务辅助函数（`handleApplyDraft`、`handleRollbackToMessage`、`handleMessageDiff`）保持不变，现在运行于共享外壳之上。SP-4 落地后，Luker 中全部五个 AI 驱动的编辑面（编排器、记忆图、CEA CardApp Studio、CEA 角色编辑器、CPA）共享同一个外壳、同一种存储模型、同一套 edits-lib 与同一个冲突解决 UI。
- **CEA 角色编辑器基于迭代工作台外壳重构**（适配器迁移 SP-3）。世界书同步分析弹窗被多轮迭代会话替代。一个适配器同时编辑角色卡与世界书；新增 3 个 CEA 自有的 edits-lib 自定义 op（`lorebook_entry_add / update / remove`），以条目 uid 为键。外壳现每次打开时调用一次 `adapter.registerCustomOps(registry)`。旧的 `lorebookSyncHistory` 设置项会在首次打开时被清除；磁盘上的角色卡与世界书数据不受影响。
- **迭代工作台适配器合约 v2（IDE 风格）。** Shell 不再持有 `workingProfile` 快照；适配器的 `live()` 为唯一权威源。已迁移内置 orchestrator + memory-graph 适配器。外部适配器需要相应升级（参见 `docs/zh-CN/development/extension-api/iteration-studio.md`）。升级后首次打开时按适配器清空一次旧的迭代工作台会话数据；实时数据（预设文件、角色卡、设置）不受影响。CEA 与 CPA 适配器将在后续版本提供。

---

详细的逐版本更新日志将在后续补充。如需了解具体功能的详细信息，请参阅对应的文档页面。
