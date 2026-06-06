# 扩展 API 参考

本文档是 Luker 扩展 API 的完整参考，面向插件开发者。所有 API 均通过 `Luker.getContext()` 暴露。完整参考分为以下子页面：

| 页面 | 涵盖内容 |
| --- | --- |
| [聊天与状态](/zh-CN/development/extension-api/chat-and-state) | 聊天数据、统一消息 API、聊天持久化、聊天状态、楼层状态、角色状态、聊天生命周期、swipe API、扩展 prompt、媒体辅助函数 |
| [角色卡](/zh-CN/development/extension-api/characters) | 角色卡、V2/旧版 Proxy 语义、标签、导入 / 导出、按角色的状态 |
| [世界书](/zh-CN/development/extension-api/world-info) | 世界书 CRUD、激活扫描、角色辅助世界书 |
| [预设与提示词](/zh-CN/development/extension-api/presets-and-prompts) | `context.presets.*`、`buildPresetAwarePromptMessages`、`resolveWorldInfoForMessages`、信封检视、reasoning 辅助函数、设置视图 |
| [生成请求](/zh-CN/development/extension-api/generation) | `generateTask`、工具注册、`generateRaw` / `generateQuietPrompt`、Service 类、连接配置 |
| [Slash 命令](/zh-CN/development/extension-api/slash-commands) | 注册和执行 slash 命令、命名 / 非命名参数、枚举 |
| [宏与变量](/zh-CN/development/extension-api/macros-and-variables) | 宏注册、内置宏参考、`substituteParams`、本地与全局变量 |
| [Skill](/zh-CN/development/extension-api/skills) | `context.skills.*` —— 安装、读取、写入、搜索、迁移作用域、嵌入打包 / 抽取；CardApp ctx 对等 |
| [UI 与弹窗](/zh-CN/development/extension-api/ui-and-popups) | 弹窗、加载器、模板、消息格式化 |
| [IterationStudio](/zh-CN/development/extension-api/iteration-studio) | AI 驱动迭代编辑的共享弹窗框架 —— 对话、会话、diff 预览、批准 / 拒绝生命周期。adapter 提供工件形状和工具 |
| [插件集成](/zh-CN/development/extension-api/plugin-integration) | 正则运行时、搜索工具、扩展 API 注册表、事件系统、i18n、设置存储、调试与抓取器注册、tokenization、工具函数、符号与常量 |
| [底层端点](/zh-CN/development/extension-api/low-level-endpoints) | 原始 HTTP 路由（仅供高级 / 调试场景使用） |

## 全局入口

```js
const context = Luker.getContext();
```

| 别名 | 说明 |
|------|------|
| `Luker.getContext()` | 推荐使用 |
| `SillyTavern.getContext()` | 兼容别名 |
| `st.getContext()` | 兼容别名 |

新插件应统一使用 `Luker.getContext()`。兼容别名仅为迁移期保留。

## 命名空间速查

为了便于快速定位 API 所在位置，context 对象将相关 API 分组成命名空间：

| 命名空间 | 内容 |
|------|------|
| `context.presets` | `list`、`getSelected`、`getLive`、`getStored`、`save`、`resolve`、`readExtensions`、`writeExtensions`、`state.*` |
| `context.connectionProfiles` | `list`、`resolve`（不推荐直接使用） |
| `context.variables.local` | `get`、`set`、`add`、`inc`、`dec`、`del`、`has` |
| `context.variables.global` | `get`、`set`、`add`、`inc`、`dec`、`del`、`has` |
| `context.swipe` | `left`、`right`、`to`、`show`、`hide`、`refresh`、`isAllowed`、`state` |
| `context.symbols` | `ignore`（`IGNORE_SYMBOL` 哨兵值） |
| `context.constants` | `unset`、`promptRoles`、`promptTypes`、`wiAnchor`、`wiPosition` |
| `context.macros` | `register`、`registerAlias`、`registry`、`engine`、`category`、`envBuilder` |
| `context.loader` | `show`、`hide`、`active`、`get`、`isBlocking`、`ToastMode`、`Handle` |
| `context.skills` | `list`、`get`、`readFile`、`listFiles`、`search`、`writeFile`、`editFile`、`deleteFile`、`install`、`delete`、`rename`、`moveScope`、`importBundled`、`listBundledManifest`、`packForEmbed`、`previewExtractEmbed`、`executeExtractEmbed`、`importFromUrl` |
| `context.worldInfoEntry` | `template`、`create`、`delete`、`setButtonClass`、`setGlobalSelection`、`getSorted` |
| `context.chatWorldInfo` | `getNames`、`setSelection`、`globalSelection` |
| `context.openai` | `proxies`、`ZAI_ENDPOINT`、`stripPresetConnectionFields` |
| `context.textCompletion` | `types` |
| `context.secrets` | `KEYS`、`state` |
| `context.lib` | `DOMPurify`、`lodash`、`DiffMatchPatch`、`showdown`、`yaml` |

## 与 SillyTavern 的 API 差异

Luker 基于 SillyTavern 构建，但在 API 层面有以下主要差异：

| 领域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整文件覆写 | Patch-first（RFC 6902 增量更新） |
| 聊天绑定状态 | 仅 `chat_metadata` | 新增聊天状态机制 + 楼层状态 |
| 按角色的状态 | 无 | `getCharacterState` / `setCharacterState`（独立于角色卡 JSON） |
| 预设管理 | 直接导入内部模块 | `context.presets.*` 统一 API |
| 提示词组装 | 需要手动拼接 | `buildPresetAwarePromptMessages()` |
| 世界书模拟 | 无 | `simulateWorldInfoActivation()` |
| 角色辅助世界书 | 无 | `getCharaAuxWorlds()` |
| 生成钩子 | 基础事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等细粒度钩子 |
| 事件排序 | 注册顺序 | 支持 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正则运行时 | 无插件 API | `registerManagedRegexProvider()` |
| 搜索工具 | 无插件 API | `Luker.searchTools` 全局 API |
| 函数调用 | 基础 `ToolManager` | 纯文本模式支持 + 连接级独立开关 + `sendOpenAIRequest` 预设覆盖 |
| 连接配置 | 全局单一 | `context.presets.resolve()` 支持按预设解析连接配置 |
| 宏引擎 | 字符串替换 | 结构化 `macros.register()`，带处理器上下文、参数、分类 |
| 角色对象 | 朴素 V1/V2 字段 | Proxy，带 V2 规范化和旧版写入弃用警告 |

> [!IMPORTANT]
> 优先使用 `Luker.getContext()` 提供的 API，而非直接调用底层 HTTP 端点。Context API 封装了 patch-first 语义、冲突处理和重试逻辑，直接调用端点需要自行处理这些细节。

## 相关页面

- [前端插件开发](/zh-CN/development/frontend-plugin) — 插件结构、事件系统、UI 集成
- [角色卡开发](/zh-CN/development/card-developers) — 角色卡扩展字段和 CardApp
- [增量同步](/zh-CN/improvements/incremental-sync) — 增量保存的技术细节
- [预设解耦](/zh-CN/improvements/preset-decoupling) — 预设与 API 选择的解耦机制
