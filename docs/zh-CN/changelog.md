# Changelog

本更新日志覆盖 Luker 自 v1.0.0 起的每一个版本，直至当前开发版。已发布版本的条目取自 GitHub 上的版本发布说明，「未发布」一节记录下一版的改动。

## 未发布

### 多智能体编排

- **新增两个出厂导演预设**，每个模式都有预设说明，可一键导入。
- **技能可以绑定到编排预设**，随预设改名、删除与导出。
- **导演、循环与议程智能体可以用查找替换工具修改自己的系统提示词**。
- **自定义工具可以在迭代工作台里编写并试运行**。
- 每个预设可定义世界书过滤规则，在智能体读取世界书的所有场景生效。
- spec 与 agenda 智能体现在会读取 Open Notes。
- 用户正则会作用于智能体的输入与输出。
- 提升了智能体轮次上限，并移除了可配置项里隐藏的数值上限。
- 编排器设置抽屉重组为「智能体」「工具与技能」「通用」三个标签页，所有改动自动保存。
- 运行面板显示每个智能体的用时，模拟审查会把最终输出置顶并自动折叠已完成回合。
- 停止运行现在立即生效，不再等当前轮次结束。
- 修复了新建或重命名预设后选项不刷新的问题，全局迭代保存也不再复活已删除的智能体。

### 记忆图

- **新增图谱修订工作台**：AI 提出的修改以差异卡片预览，可逐条批准或回退。
- **新增剧情线节点**，用于追踪长期主线。
- 抽取新增爬取模式：抽取前先探索图结构，初始只提供图的大致样貌，节省提示词。
- 召回精简为 LLM 与 RAG 两种模式，并支持可选的重排与查询改写。
- 召回按节点类型均衡分桶，单一类型不再挤占其他记忆。
- 长期注入的节点超出时间窗后回退到普通召回，不再直接丢弃。
- 事件抽取现在能区分角色亲身经历与单纯提及，对称关系合并为一条边。
- 向量检索只返回具体事件，汇总摘要不再干扰结果。
- 用户正则会作用于抽取读入的文本。
- 设置抽屉重组为召回、抽取、图谱、高级四个标签页，并全面补齐字段说明。
- 修复了空回放清空图谱、重置聊天后旧向量残留、读取失败静默返回空数据等问题。

### 角色卡编辑器（CardApp Studio）

- 修复了一批卡片编辑可靠性问题：已应用的修改不再自行回滚，回退按钮恢复可用，重复的差异卡片不再出现。

### 迭代工作台

- **四个工作台的会话现在会保存并回放工具调用与结果**，刷新后不丢失。
- **工具调用以差异形式展示**，消息卡片显示思考链。
- **重新生成会先撤销已应用的修改**，每条用户消息都新增了编辑按钮。
- AI 改为按需读取所需字段，不再一次性展示全部内容，修改失败时也会给出明确的定位诊断。
- 失败的工具调用返回真实错误与原因，不再静默跳过。
- 会话历史移到各角色独立存储，关闭弹窗立即保存，不再丢失最后一轮。

### 预设与提示词管理器

- **一张角色卡现在可以绑定多条聊天补全预设**，可设定默认与覆盖，并可一键清空。
- **提示词可以附着到指定消息**，不再只支持相对位置。
- 预设作用域的世界书支持导出导入往返。
- 提示词条目可以拖入既有分组，并修复了子分组渲染问题。
- 插件提示词结构对缓存更友好，重复请求更快、开销更低。
- Claude 提示词缓存与压缩后处理同时启用时，连接管理器会给出警告。
- 卡片绑定预设的修改会保存回卡片，不再因清除而丢失。
- 删除预设会连带清理所有关联状态。

### 连接与模型

- **每个连接配置可以设置独立的请求超时与重试策略**。
- **新增 OpenAI Responses 聊天补全来源**。
- Kimi 支持 partial prefill，并正确转发推理内容。
- 识别较新的 Claude 5 与 Opus 4 模型，移除阻断 Bedrock 的过时参数。
- 高级请求设置折叠进抽屉。
- Google AI Studio 的概率性安全拦截现在可重试，并修复了 Vertex 模型列表。
- 模型选择器不再选错项，也不再凭空捏造选项。
- 修复了切换连接配置时模型字段被覆盖的问题。

### 生成与流式

- **聊天补全、文本补全、NovelAI、Kobold 与图像生成统一了生成流程**，修复了 Bun 下的生成问题。
- **Claude 思考块跨轮次保留并重放**，DeepSeek 与 OpenRouter 的推理内容同样端到端保留。
- 停止请求即时送达供应商，ComfyUI 出图可中途打断。
- token 计数与 token 编码可以独立配置。
- 恢复生成的客户端能重新看到实时流式文本。
- token 计数移到后台线程，长提示不再卡住界面；更多分词器改为本地内置。
- 上游错误以正常错误响应返回，不再挂起或被截断。
- 空响应自动重试，Gemini 安全拦截仍按终态处理。
- WebSocket 推流不再在重连后重复收文本，大载荷不再受限。

### 聊天与角色

- **角色卡替换改为全屏差异总览。**
- **聊天可以按所选顺序合并，或在指定位置拆分。**
- 流式生成的 token 用量现在会显示出来，并统一各供应商的格式。
- 聊天搜索现在能越过已加载窗口继续查找。
- 关闭页面前未保存的聊天会强制保存，保存冲突自动恢复，失败时显示服务器错误。
- 聊天文件名不再累积重复扩展名。
- 快速切换角色时不再写入错误的聊天。
- 编辑消息时推理块的提交与取消干净利落。
- 角色保存失败会显示真实错误，内嵌世界书在编辑后保留。

### 世界书

- **移动端世界书编辑界面改造**，布局更精致，切换视口后设置不丢失。
- 卡内世界书重新加载后保持绑定，已删除条目不再混入导出数据。
- 数组形式条目的世界书可以正常导入和编辑。

### 请求检查器

- **推理内容、思考块与签名以样式化块显示在请求与响应视图里**。
- 上游原生结束原因与规范化结果并排显示。
- 向量请求与重排请求同聊天请求一起被捕获。
- 非流式请求与早期失败也会被记录，流式响应逐块检查。

### 存储与同步

- **新增 SQLite、MySQL 与 PostgreSQL 存储引擎**，附带迁移面板，迁移中断后可从进度处继续。
- **备份管理器支持在存储模式之间转换备份**。
- 新增服务器端与浏览器端存储检查器，可逐层查看子目录。
- 恢复包分块上传，支持断点续传。
- LAN 同步改为流式传输。
- 文件系统与数据库双向迁移时保留聊天完整性与时间戳。
- 删除聊天或角色会连带清理其媒体文件。
- 不安全的存储文件名会被拒绝。

### TTS

- NPC 台词可以按说话角色朗读，并支持逐句播放。

### 搜索插件

- 搜索前置智能体不再与世界书操作相互冲突。
- 条目位置不是「聊天深度」时，注入深度与角色字段自动隐藏。

### UI 与移动端

- **Android 新增可分享的崩溃诊断包**，崩溃循环时自动禁用第三方扩展进入安全模式。
- Android 冷启动更快，调试版可直接覆盖安装正式版。
- iOS 键盘不再破坏视口布局。
- 修复了 Android 视口高度与全屏布局问题。

### 认证与用户

- 新 OAuth 账户以供应商头像初始化，OAuth 专属账户拒绝密码登录，调试导出详情仅管理员可见。

### 国际化

- 懒加载媒体设置、管理面板动态值与滑条选择器补齐简繁中文翻译。

### 平台

- 跟进 SillyTavern 1.19.0。

### 补全预设助手

- **迭代工作台可以导入现有聊天作为起点**。
- 修改冲突与已应用操作会明确报告，不再被静默忽略。

### 背景保活

- 新增移动端保活开关，以画中画或音频方式保持后台生成继续运行，音频仅在生成时播放。

### 扩展 API

- 新增角色状态读取、写入与批量获取助手，暴露 saveChatDebounced，并新增召回结果查询与页面内渲染记忆图 UI 的接口。
- 角色替换的世界书处置逻辑移入核心替换流程。

## v2.7.0 (2026-06-13)

### 多智能体编排

- 新增预设库——每种模式（spec / agenda / loop / director）都可以在全局与单角色两种作用域下保存多个预设，旧的单槽位配置会在首次打开时迁移为默认预设。
- 新增运行面板：运行开始的瞬间便会滑入聊天旁（移动端则从底部滑入），实时流式显示推理、文本、工具调用与子 agent 动态，关闭后可从悬浮胶囊重新打开，并在标题栏显示累计 token 总数。
- 移除了旧的运行时轨迹弹窗——现在所有场景都由运行面板接管。
- 子 agent 现在可以用正则表达式精确匹配定位，并对聊天记录、世界书条目、SKILL 文件以及 director 进行中的草稿获得行级输出。
- 全局作用域下的迭代工作台现在可以读写世界书，全局编排因此能够审计并编辑全局生效的条目。
- 补全预设助手的编排适配模式现在会执行结构性检查，标记出落在错误层级上的 agent 身份内容、SKILL 引用以及越狱响应形态动词。
- 修复了 director 模式的停止按钮：点击后会在工具之间以及子 agent 等待期间立即中止，而不再等待轮次边界；同时消除了快速“停止 + 重新生成”可能让两个 agent 写入同一槽位的问题。
- 提升了模拟弹窗中文本选择标记的性能。
- 修复了“清除角色覆盖”和“重置为默认”按钮。

### 角色卡编辑助手

- 除非用户明确点名，AI 不再写入场景、系统提示词或 post-history instructions 字段——内容会被引导到世界书中。

### 迭代工作台

- 各弹窗中的 diff 卡片现在都以一致的方式渲染。
- 调色板更明亮，更接近 GitHub 的风格。
- 改进了迭代工作台的提示词。

### 记忆图

- 记忆图的提交现在会正确锚定在触发操作的楼层上。

### 性能

- 长提示词的 token 计数不再阻塞 UI。
- 提升了聊天视图与提示词管理器的性能。
- 将启动时的版本检查改为非阻塞，避免缓慢网络导致首屏卡顿（感谢 @1362278443 提交的 PR）。

### 修复

- 一键调试导出包现在会包含完整的请求检查器历史；打包过程移到了服务器端。
- 楼层状态不再因历史日志损坏而卡死——损坏的楼层及其相邻提交会被截断，损坏部分归档为孤立日志，更早的楼层状态则完整保留。
- 修复了世界书抽屉在切换条目后重置的问题。
- 修复了 Claude 后端提示词缓存在系统内容经后处理合并进首条用户消息时的问题。
- 启动后 uploads 目录被删除不再导致上传永久报错；目录会在需要时自动重建。

### 默认 SKILL

- 反套路 SKILL 新增了数词 + 量词的禁用项。

### 文档

- 新增了 agent 预设文档。
- 新增了编写自定义编排工具的文档。
- 新增实战指南“按卡片自定义编排”，通过三个步骤演示——从一句话生成该卡片专属的编排、用模拟和批注标记套路与意外输出以便工作台改进编排、让 AI 编写一个校验输出格式的自定义工具。

### 新贡献者

* @1362278443 在 https://github.com/funnycups/Luker/pull/12 中完成了第一次贡献

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.6.1...v2.7.0

## v2.6.1 (2026-06-07)

### 搜索

- 编排工具不再受插件 enabled / preRequestEnabled 开关的限制

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.6.0...v2.6.1

## v2.6.0 (2026-06-07)

### 亮点

- 新增 Skill 子系统：将可复用的写作方法、角色声线、反套路规则与整理手册收录为 SKILL.md 文件，按全局 / 角色 / 预设三种作用域保存，在多智能体编排内以 chip 的形式为每个子 agent 挂载，并由运行时将匹配到的 skill 目录注入 agent 的上下文；自带 21 个中文创作 skill（角色声线、故事头脑风暴、反套路、记忆整理等），可以在迭代工作台或 CPA 对话框中交互式编写，并可通过打包导入/导出随角色或预设一起迁移。
- 为多智能体编排新增自定义工具系统：注册你自己的工具供 AI 在全部四种模式（Agenda、Spec、Director、Loop）中调用；内置的记忆、联网搜索与预设管理以可自行开启的工具形式提供；每个 agent 都有专属的覆盖面板用于选择启用哪些工具；随导入角色卡内嵌的工具则提供内联审核流程。
- 新增模拟审核弹窗：在多智能体编排或角色 / 预设助手中点击“模拟”现在会执行一次真实的静默生成，并展示完整的 agent 链、最终输出以及被触发的世界书条目；你可以选中文本添加行内批注，一键重新运行，批注会回流到工作台 AI，作为下一轮迭代的指引。模拟期间写入类工具处于沙箱中，不会泄漏任何内容到真实数据。

### 多智能体编排

- 在迭代工作台内新增世界书写入工具：AI 可以停用或重写当前角色上的世界书条目，每一处改动都会落成一张 diff 卡片，由你逐张批准或拒绝，且只有获批的部分会在你按下应用时提交。
- 在 director 模式为每个子 agent 新增工具调用轮次上限：批评者式的子 agent 可以收敛在一到两轮，而记忆侦察者式的子 agent 可获得更宽裕的预算。
- 在每种模式的角色覆盖配置旁新增启用 / 停用开关，让你可以临时回退到全局配置而无需删除整个覆盖。
- 将推理轨迹扩展到 Spec、Agenda 与 Loop 模式（director 此前已具备），因此 Claude thinking、OpenAI o1 及类似的推理内容现在会显示在多智能体编排全部四种模式的运行时轨迹中。
- 运行时轨迹现在会把每次工具调用与其结果以内联方式配对，放在 args / result / error 标签之下，而不再散落在时间线上。
- 强化了子 agent 的身份框架：子 agent 提示词被重组为四段式元框架，不再因尾部的角色指令而漂移成“让我以角色身份继续场景”。
- 修复了 director 模式下角色覆盖配置看似没有保存的问题。
- 修复了子 agent 在第一轮看不到进行中草稿的问题——这曾导致批评者针对错误的修订版本给出反馈。
- 修复了记忆图写入被拒时错误被静默忽略的问题：AI 现在能看到真实的失败原因，而不是无限重试。
- 修复了从已删除消息中提取的记忆条目残留为无效条目并在重新生成后被再次注入的问题。
- 修复了多智能体编排写入记忆图时未转发进行中楼层，导致提交落在空占位符上的问题。

### 角色 / 预设助手（CEA / CPA）

- CPA 的“编排优化”环节现在默认将重写后的指引条目移到 chatHistory 之前，只把越狱 / 解锁类的条目留在尾部，使生成的预设结构上更稳定。
- 改进了 CPA 中关于在预设内管理 prompt_order 的指引，让 AI 在修订预设时能更好地塑造 RP 输出。
- 修复了迭代对话框的停止按钮在慢速连接下毫无反馈的问题——它现在会立即变为禁用并呈现中止状态。

### 客户端分词器

- 将 OpenAI、Claude 与 HuggingFace 系列的 JSON 分词器完全移到浏览器端，聊天输入框旁的实时 token 计数器无需服务器往返即可响应。
- 将客户端分词扩展到更多 sentencepiece 模型系列：gemma、gemini、llama、mistral、yi、jamba。
- 任意自定义模型名称（OpenRouter ID、私有部署别名等）会在分发前归一化到正确的分词器，仅在无匹配时才回退到服务器。
- 不活跃的按聊天 token 缓存会在切换聊天时被逐出，使长时间会话的内存占用保持平稳。

### 沉浸模式与移动端

- 沉浸模式状态现在可跨重新加载与重启保持，并在网页客户端与 Android 应用之间随账户同步。
- 在用户设置中新增“沉浸模式下保留顶栏”开关；开启后聊天区域会调整大小，为顶栏留出空间而不是与其重叠。
- 新增右上角悬浮退出按钮：在沉浸模式开启且顶栏隐藏时显示，主要让没有 Esc / 返回键的 iOS 用户也能退出沉浸模式。
- 改进了 Android 返回键行为：用户手动开启的沉浸模式不再被返回键强制关闭；返回键现在会先关闭已打开的弹出框与对话框；在聊天内，返回键会先关闭当前聊天回到欢迎页，需要再按一次才会真正退出应用。
- 修复了 Android 应用把用户主动退出误判为上次会话崩溃并在下次启动时显示崩溃报告对话框的问题。
- 改进了 Android 崩溃捕获，使 JVM 未捕获异常与 WebView 渲染进程崩溃能真正把堆栈跟踪带入下次启动的崩溃报告。
- 在 Android 客户端中，同源下载改用应用内流式传输取代系统 DownloadManager，并带有进度通知与失败原因提示，修复了登录会话与 DownloadManager 相互隔离导致备份下载失败的问题。

### 第三方扩展

- 从 github.com/funnycups/ 安装扩展不再触发“第三方扩展”安全警告。
- 将第三方扩展安装确认对话框（标题、“是，安装” / “否，取消”按钮、“不再显示”选项）完整翻译为简体中文与繁体中文。
- 修复了多个扩展同时启用时的跨加载顺序回归——像 ST-Prompt-Template 与 JS-Slash-Runner 这样的组合现在能正确渲染。

### 备份与文件

- 用户备份恢复对话框现在会依次流式显示分析、快照与逐文件解压阶段的进度（第 X / Y 个文件及百分比），而不再停留在静态的“正在恢复”提示上。
- 修复了名称首尾带空格的角色卡世界书导入会打开空编辑器或显示错位条目的问题。

### 界面优化

- regex 扩展面板现在可以独立折叠和展开预设、全局、角色、聊天与作用域这几个分区。
- 提示词管理器与 regex 脚本列表在重建时会释放分离的 DOM 节点，长时间会话不再因残留的拖拽绑定而积累内存。

### 其他修复

- 修复了多个聊天补全源同时启用时，多源 OpenAI 兼容流式回复针对共享全局状态进行解析的问题。
- 修复了 Takeover 插件将上一个 swipe 的文本与推理带入重新生成回复的问题。
- 修复了 Takeover 插件在超出最后一个槽位的越界 swipe 被重新生成时丢失推理及其他附加内容的问题。
- 修复了 variable-op-log 无法识别变量简写的问题：<span v-pre>`{{.x = v}}`</span>、<span v-pre>`{{.x++}}`</span>、<span v-pre>`{{$g}}`</span>、<span v-pre>`{{.x ??= 1}}`</span> 现在不会在消息中留下字面量，并会以读取或写入的形式记入操作日志。
- 修复了记忆图在数据损坏时无法加载的问题：孤立节点现在会被自动修剪，状态可以从备份快照恢复，并移除了过时的“检测到聊天变更，将在下次生成时重新同步”提示。
- 修复了连接管理器尝试同步已不存在字段的问题，避免配置在后台被悄悄改动。

### 文档

- 在 docs/development/extension-api/ 下新增了三语扩展 API 文档，涵盖 character-overrides、Skill 的迭代工作台接口以及完整的角色卡编辑助手 API；仓库还新增了一条 lint，禁止插件相互导入或直接导入核心——必须经由三层 getContext() / getExtensionApi() 接口。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.5.1...v2.6.0

## v2.5.1 (2026-05-27)
### 多智能体编排
- 优化了 Director 模式下 agent 召回记忆图的默认提示词。

### 修复
- 切换 OpenRouter API 连接配置后模型保持不变的问题。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.5.0...v2.5.1

## v2.5.0 (2026-05-27)
### 预设与帮助指南
- 新增「plugin-only」预设，将角色扮演设置（角色设计、角色卡、场景、世界书、对话示例）与插件任务通道拆分为两个独立区块。插件指令不再被视为 AI 剧情的一部分。
- 在所有预设选择器旁新增「?」帮助按钮：插件与迭代 AI 预设可一键导入「plugin-only」预设；多 Agent 预设会跳转到多 Agent 入门指南。
- 预设助手的越狱模式会同步教会 AI 这套区块划分，生成的越狱预设直接遵循新的约定。

### 预设迭代
- 扩大了迭代 AI 可直接修改的字段范围。工具调用、agent 相关开关、采样、多模态等字段现在可由 AI 按用户意图调整。
- 在「参考预设」选择器旁新增「?」帮助按钮，说明什么是参考预设、何时应选「无」。

### 记忆图
- 重写事件摘要撰写指南：采用编号大纲格式、按动作类型归类、去掉引号与细节重复，摘要明显更短、更聚焦。
- 事件压缩阶段现在会执行真正的主题合并（合并同主体、同动作的不同对象），消除机械的条目堆叠。
- 提取阶段现在要求 AI 在创建或编辑角色与地点前逐项核对图中已有节点，减少重复创建。
- 修复创建分支聊天时记忆图错误跟随的问题。

### 多智能体编排
- 记忆整理模块现在采用新的事件摘要指南与主题合并规则，与记忆图保持一致的质量。
- 修复切换聊天后 Director 编排面板显示「当前聊天中没有运行中的轨迹」的问题；轨迹现在会正确绑定到当前聊天。

### 文档
- 优化了 Agent 入门指南。

### 平台与体验
- 用户设置现在会显示当前对应的 SillyTavern 兼容版本，便于核对版本差异。
- Android 客户端的状态栏与导航栏颜色现在跟随主题配色。
- 数据备份导入现在会显示上传进度百分比与处理状态。

### 修复
- 修复移动端上迭代弹窗（聊天补全预设助手、角色编辑器、多智能体编排、记忆图）发送按钮被截断的问题。
- 迭代弹窗中的 diff 卡片默认折叠，长历史条目不再纵向占满页面，移动端也不会再出现渲染异常。

### 性能
- 修复 STscript 解析长参数（超长 base64、包含大量管道的命令）时的长时间卡顿问题。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.1...v2.5.0

## v2.4.1 (2026-05-26)
- 修复补全预设助手的加载问题
- 为多智能体编排加上 agent dispatcher 开关
- 修复多智能体编排子 agent 中的一个问题

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.4.0...v2.4.1

## v2.4.0 (2026-05-25)
### 文档
- 新增三语实战指南板块，首篇实战指南带新用户端到端走完完整的多 agent 写作工作流：创建纯 agent 预设、把正文写作与迭代拆到两条独立的 API 通道、将记忆图的提取/召回/压缩交给子 agent、接入搜索引擎，最后在 AI 迭代工作台里整体调优——并附带配套的最小起步预设与分步截图。

### 多智能体编排
- 每个 agent（主 agent 加 12 个内置子 agent）现在都能有独立的工具权限，可按 agent 继承或覆盖，并按各子 agent 的角色定制默认工具集（memory curator 获得记忆写入权限，voice critic 获得只读聊天权限，等等）。
- 打磨运行轨迹弹窗：现在可按轮次/按派遣阅读每个 agent 的推理；Director 面板改为双栏布局；总览卡片会报告主 agent 轮次数与子 agent 派遣次数。

### AI 迭代弹窗（CardApp Studio / 记忆图 / 多智能体编排共用）
- 修复审阅完一批待处理 AI 变更后弹窗卡住的问题——应用/丢弃现在会自动恢复循环，AI 能看到你接受了哪些、拒绝了哪些变更，并据此调整下一步行动。
- 修复 AI 看不到上一轮变更是否真正生效的问题；反馈现在会报告成功多少、失败多少及其原因，以及哪些条目的哪些字段实际发生了变动，AI 不再重复提出同一条无效变更。
- 修复内联代码片段在着色消息气泡上难以辨认的问题。
- 修复一轮提出大量变更时 diff 卡片在窄屏/移动端视口闪现大片白底的问题。

### 记忆图
- 修复 v2.3.0 引入的严重数据丢失问题：自动提取、自动压缩、手动增量补全/重建最近/手动压缩以及编辑器中的每一次新增/编辑/删除，在 UI 上都显示成功，却会在下次刷新或重新生成消息时静默回滚到早前几层的状态。
- 修复静默保存失败的问题——持久化失败现在会弹出带完整上下文的三语 Toast，方便截图上报。
- 修复向量召回索引每次切换聊天或刷新时都从头重新嵌入 50 个节点的问题；增量同步现已实现跨重新加载的增量更新。

### 预设助手
- 新增以标识符为键的工具，可精确编辑预设内的提示词条目（对内容执行替换/插入/删除，外加启用/停用开关），AI 不再改错条目，也不会因写错字段而反复重试同一条失效开关。
- 重写「多智能体编排优化」模式的指导，把「会毒化 agent 工具调用通道的流程强制」与「安全的最终输出修饰」区分开，给出的建议更一针见血；并移除了误报的 Director 预设警告横幅。
- 修复「将当前预设克隆为新预设」工具无效的问题——此前 AI 的调用会静默失败，现在克隆会生效并切换到新预设。

### 其他
- 修复 Luker 更新横幅在任何界面语言下都显示英文原文的问题。
- 修复保存聊天时偶发的「聊天补丁冲突」问题，此前需要自动重试才能保存成功。
- 修复 CardApp 第三方 `sendMessage` 的 silent 选项并未真正静默的问题——消息仍会进入聊天记录；现在它会真正静默运行，并把 AI 的回复以字符串返回给调用方。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.3.0...v2.4.0

## v2.3.0 (2026-05-25)
### AI 迭代弹窗
- 为五个插件——补全预设助手、记忆图 schema、多智能体编排、角色编辑器与 CardApp Studio——新增统一的 AI 迭代弹窗，让 AI 直接在弹窗内修改草稿；具备分栏实时预览、多轮对话、按消息切换工具调用可见性、重新生成与回滚、带 diff 的内联应用、依据 AI 是否仍在调用工具的自动续轮、世界书读取工具，以及扩展设置中查看和编辑各弹窗 AI 系统提示词的入口。

### 文档
- 重写一大批文档，涵盖编排笔记、迭代工作台框架开发指南与新的记忆图 API 章节，统一术语并规范中日韩标点。
- 为文档站的每个页面新增社交卡片元数据。
- 补全管理面板与 AI 迭代弹窗的本地化。

### 多智能体编排
- 将编排笔记重新设计为面向 AI 的作者侧剧情线索追踪器。
- 新增意图侦察子 agent，交叉比对用户意图并产出世界书撰写指令。
- 收紧 Director 与记忆相关子 agent 的提示词，使其协作更顺畅、遵守字段纪律、把握正确的层级；现在遇到元叙事、底层模型名称、「上一轮」式引用等平台框架泄露会直接中止。
- 重构角色覆写编辑流程，移除旧的 AI 快速构建入口。
- 将子 agent 每任务最大轮次从 8 提升到 16。
- 移除硬性自动续轮上限，使其跟随实际生效的上下文范围，并持久化收尾状态。

### 记忆图
- 新增记忆图只读 API 与 session 式扩展 API，第三方扩展一次调用即可完成读写并自动提交版本。
- 新增记忆图写入与压缩 API、memory curator 子 agent，并提升内置提取质量。
- 通过统一的 7 步推理模板与自检回退改进事件摘要提取。
- 收紧记忆生成提示词，禁止作者口吻收尾与杜撰的心理状态标签，并强化别名收集、关系规范化与位置状态字段纪律。
- 调整每批事件策略：每批必须产出事件，仅稳定事实类型默认跳过。
- 提升移动端大型记忆图的导入速度。
- 将主上下文注入窗口与召回候选池解耦。

### CardApp 与角色编辑器
- 为变量系统新增基于路径的 set/delete 与 push/pop 操作，接入斜杠命令、宏、JS API 与 Studio AI。
- 改进 CardApp Studio 文件操作：统一经由编辑通道批量执行，每轮均需审批。
- 为角色编辑器新增世界书查看器、分页、搜索与移动端 tab 布局。
- 让角色编辑器的 AI 工具可直接读写世界书递归字段。

### 应用内公告
- 新增管理员可发布的应用内公告系统，单用户模式下铃铛自动隐藏，并附带三语使用文档。

### 稳定性与可观测性
- 大幅提升聊天保存可靠性，修复多起偶发的消息丢失、事件缺失与编辑/删除后保存冲突问题。
- 新增自动请求重试，重试次数按连接配置单独设定，文本与图像生成均受益。
- 进程退出时转储进行中的请求，原生中止时输出诊断报告。
- 在请求检查器中显示每个请求的上游端点与密钥指纹，并在源消息旁展示实际发出的请求载荷。
- 无论是否处于调试模式，控制台各级日志都会写入前端日志缓冲区，导出的调试日志因此完整。
- 改进接管流程，明确三种终态——已提交、已中止、已丢弃——并在气泡上提供实时计时器与最终 token 计数。

### 安全与访问
- 新增可选开启的自助注册入口。

### 其他体验
- 在 API 连接配置中开放 Claude 与 Gemini 提示词缓存开关。
- 搜索插件新增手动条目管理弹窗，用于维护已存条目。
- 世界书高级关键词搜索支持按角色筛选。
- 新用户默认开启角色懒加载，加快启动速度。
- 优化「模型请求」标签中的预设措辞，并移除旧的「单 Agent」表述。
- 修复彩色背景下 Toast 通知中的详情小字难以辨认的问题。
- 修复中日韩按钮文字竖排显示的问题。
- 修复预设管理器左侧抽屉在切换预设时丢失滚动位置的问题。
- 修复扩展管理器弹窗在刷新时覆盖实时开关状态的问题。
- 修复弹窗滚动时背景遮罩透出导致内容发虚的问题。
- 修复脚本设置的反向代理被 Base URL 覆盖的问题。

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.2.2...v2.3.0

## v2.2.2 (2026-05-18)
- 修复了多智能体编排的 Director 模式无法读取思维导图的问题。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.2.1...v2.2.2


## v2.2.1 (2026-05-18)
- 优化了 Director 模式的提示词结构。
- 隐藏并整理了 Director 模式中与指令注入相关的配置。
- 修复了角色卡编辑助手等插件的 CardApp Studio/角色卡编辑弹窗中文字无法自然换行的问题。
- 优化了角色卡编辑助手弹窗的输入框大小。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.2.0...v2.2.1


## v2.2.0 (2026-05-17)

### 多智能体编排

- **新增 Director 模式。** 一个八 agent 阵容——chat / memory / lorebook / epistemic / canon 侦察员、一名剧情头脑风暴员、以及 voice / continuity 两位评论员——通过接管钩子直接产出 assistant 消息正文，完全绕过主 LLM 分发。Director 自带一份 `pure-preset` 快照，在每次运行期间换入，使当前预设中的主提示词 / NSFW / 越狱 / 反套话文本不会泄漏进 sub-agent 上下文，快照 + 恢复机制沿用 LittleWhiteBox 模式。编排 profile 可导出为 JSON 并重新导入。两位评论员重写完毕：`voice_critic` 现在专门猎杀“数据人”文风（冷观察动词、播报式对白、人设原型处理不当，并附带一份面向中文 RP 的双语违禁词表）；`continuity_critic` 默认信任草稿，只标记硬性矛盾和知识边界违规。
- **新增工具级联。** 循环工具集（chat / memory / lorebook / note / search）现在可以在每个编排节点上启用——Loop 模式本身、Spec 节点、Agenda agent、以及 Director 的主 agent 和 sub-agent——全部共用 `profile.tools.<ns>.<verb>` 这一开关形状。解析分三层：节点级覆盖 → profile 根节点 `defaultTools` → 内置默认。UI 在工作流看板上方提供作用于整个 profile 的面板，并在每个节点体底部提供“工具（覆盖 profile 默认值）”折叠区，附带全部启用 / 全部清除快捷操作。
- **运行时 Trace 面板扩展。** 现有 Trace 弹窗现在还会展示每个节点尝试和循环 agent 的完整消息线程——system / user / assistant / tool 各轮以角色样式气泡渲染，tool_call 与 tool_result 块可折叠。Agenda 模式额外新增看板式待办面板和每轮分派卡片；循环面板以实时别名挂载，运行期间新增的消息会实时显现。
- 修复：Anthropic 的工具名正则 `^[a-zA-Z0-9_-]{1,128}$` 不接受点号，Loop 模式搭配 Claude 时请求会立即失败。十一个循环工具名（`chat_read_range`、`chat_search`、`lorebook_search/get`、`memory_search/list_recent/get`、`note_add/delete`、`search_search/visit`）已改名为下划线形式，并附带迁移垫片，把旧历史中的点号名规范化，已保存的 profile 和持久化的工具调用载荷继续可用。
- 修复：全局模式选择下拉会被内部保存的默认模式覆盖，因此带 Spec 覆盖的角色在用户点击 Loop 后仍被强制为 Spec。现在会遵循最近一次模式选择点击，与 UI 作用域标签既有的显示一致。
- 修复：多智能体编排设置面板此前只在切换聊天时刷新，替换角色卡或 AI 驱动的字段写入会让面板仍显示上一个角色的覆盖来源标签。现在这些变更都会即时刷新面板。
- 文档：每种模式开头都配 d2 默认流程图（loop / spec / agenda / director），默认 agent 已制成表格并贯穿一套共享的 Lin Wan / Luoyang 情景给出具体 RP 示例，各模式页面的 Trace 面板章节配有真实运行截图。

### 记忆图

- **按类型的抽取节奏与指令。** 节点类型现在携带两个新字段：`extractEveryN`（默认 1）通过 `currentSeq % N == 0` 把该类型限定为每 N 轮抽取一次；`extractionInstructions` 只在该类型于当前轮次激活时才追加到抽取系统提示词。某个类型轮空时，它的 create / edit / delete 工具根本不会暴露给 LLM——模型那一轮在字面上无法输出那张表，因此 `location_state` 这类慢变表可以省下 LLM 调用，又不会让抽取 agent 困惑。
- 修复：`isExtractableAssistantMessage` 把 `is_system` 当作永久排除，但 `/hide` 会在既有 assistant 消息上翻转该标志——每次隐藏/取消隐藏都会移动可抽取 seq 的排名，使已存储的节点 seq 相对聊天漂移。隐藏的消息现在与可见消息具有相同的记忆权重，符合社区惯例：`/hide` 控制的是提示词可见性，而非记忆。
- 修复：`recallEnabled` 关闭时混合召回（向量 + 扩散 + 可选重排）仍在运行，而 LLM 召回路径靠内部检查提前停止。现在召回开关在两条路径之前统一判断，禁用召回的行为一致；`alwaysInjectNodes` 的归属也从召回函数中移出，持久世界书注入仍向多智能体编排的去重发布正确的 id 集合。
- 修复：手动 `/delete` + 立即重新生成时，删除后的缓存刷新与重新生成的世界书扫描召回可能交错执行，导致召回读到过期的存储缓存。变更失效现在按顺序依次执行，召回会等待在途任务完成。
- 修复：边编辑器曾抛出“Edge form not found”，因为编辑器在弹窗关闭之后才读取表单值。现在改为在弹窗关闭前捕获值。内置边类型预设列表也已重新对齐到规范 schema（新增 `involved_in / occurred_at / evidence / updates / advances`，去掉非规范的 `involves`，移除禁用的 `located_at`）。

### 请求检查器

- 模型返回的工具调用现在可以在 Response Body 中查看。每个 `tool_call` 渲染为一张卡片，带徽标、名称、id 和排版美观的参数 JSON，并在章节标题中显示计数。OpenAI `tool_calls`、Claude `tool_use` 内容块与 Gemini `functionCall` part 全部可解析（包括流式重组：按 index 合并的 OpenAI 增量、Claude `content_block_*` 遍历、Gemini 交错的文本与函数 part）。详情级搜索现在也能匹配工具名和参数 JSON。

### 连接管理器

- **反向代理设置已并入新的“API 端点”抽屉。** 该抽屉统一管理基础 URL 与反向代理密码——此前两者分属两个面板，语义重叠、优先级含糊。这次重构带出三个连带问题，均已在本版本修复：跨源插件复用让主 API 的 `base_url` 渗入子 profile（Claude 主 API 的 `base_url` 以 `/v1` 结尾时被带进 Gemini 子 profile，生成 `https://claude-proxy/v1/v1beta/models/...:generateContent`）；`ConnectionManagerRequestService.sendRequest` 从未把 `profile['base-url']` 转发给后端，导致经以 `/v1` 结尾的 OAI 兼容代理使用 Gemini 时拼出 `/v1/v1beta/...:generateContent` 并抛出“Invalid URL”；代理密码迁移到密钥存储后，`readProviderSecret(...) || body.proxy_password || ''` 会在存在过期的已存 provider 密钥时短路，悄悄覆盖 body 中显式携带的 `proxy_password`——通过 `custom_api.key` 自带密钥的 JS-Slash-Runner 第三方脚本，其密钥会被过期的已存 MAKERSUITE 密钥替换。
- **新增按 profile 的 RPM 限制与等待 toast。** 一个滑动窗口限流器同时限制插件路径（`ConnectionManagerRequestService.sendRequest`）和主聊天补全路径；桶键为 profile id，跨插件与主聊天复用的同一 profile 共享同一窗口。等待期间常驻一条 toast，实时显示“已排队 · N 秒后下一个”倒计时；`AbortSignal` 可干净取消；`0` 或未设置 = 不限制；文本补全路径不受限制。
- **连接配置抽屉内新增 Embedding / 重排标签页。** Embedding 与重排 profile 的增删改查已从向量存储和记忆图中拆出，统一为内联编辑的 UI。这两个标签页上聊天 API 面板自动隐藏，避免可见的来源 / url / 密钥让人误以为与正在编辑的 embedding profile 相关。插件页面只保留 profile 选择下拉，并带同步逻辑：底层 profile 在别处被删除时清除已持久化的 id。已弃用的 SillyTavern Extras embedding 来源移除。
- **在支持反向代理的各来源统一为输入框驱动的模型选择器**（OpenAI / Claude / Mistral / DeepSeek / xAI / Moonshot / Makersuite / VertexAI / ZAI，加上原有的 Custom）。现在以文本输入框为准，旁边的 `<select>` 是镜像它的单次选择器，`<datalist>` 提供输入提示。此前纯 select 流程会在刚拉取的 `/v1/models` 响应中找不到已存 id 时，把 `oai_settings.<X>_model` 强制回设为 `model_list[0]`，悄悄覆盖经反向代理下发、列表未枚举的自定义 id。
- 修复：OpenAI 兼容端点地址归一化此前只检查路径尾部是否为 `/vN`。在版本号后再嵌套类别的厂商（如百度千帆的 `/v2/coding`）被错误追加 `/v1`，导致所有请求失败。现在改为匹配路径中任意位置的 `/vN`。
- 修复：刷新模型列表时，即使当前选中的模型不在新拉取的列表中，也可能被重新插入下拉菜单，导致一个未列入列表的条目固定停留在选择器上。

### 角色 / CardApp / Studio

- **新增数据驱动的角色更新 API（`updateCharacterData`）。** 角色字段写入此前要经过 jQuery DOM（`$('#description_textarea').val(x)`）并依赖以合成点击触发弹窗的保存按钮；编辑弹窗关闭后 DOM 元素不存在，写入静默失效而 `saveCharacterDebounced` 仍会触发（有时留下失效状态，例如主世界重绑后从未真正重绑的 `data.character_book` 镜像）。新 API 用点路径映射修补 `characters[charId].data`，发出 `CHARACTER_FIELDS_UPDATED`，并按 `/api/characters/edit` 本就预期的同一种 multipart 形状持久化。Studio AI 的 `character_update_fields`、CardApp 的 `ctx.updateCharacterFields`、世界书的 `charUpdatePrimaryWorld`、以及多智能体编排的持久化路径现在都经由它，无论编辑弹窗开还是关，把世界绑定到卡片都能生效。
- **新增扩展字段写入语义（`writeExtensionField` / `writeExtensionFieldBulk`）。** 两者现在通过 `/api/characters/merge-attributes` 的 `replacePaths` 旗标选择启用：完整值原样成为 `data.extensions[key]`——此前深度合并悄悄保留的同级子键不再被带入。`updateCharacterData` 现在遇到 `extensions.*` 路径会同步抛错并把调用者指向 `writeExtensionField`，静默合并的误用不会再发生。
- **新增自动应用开关。** 迭代工作台外壳（被多智能体编排的 AI 迭代弹窗、记忆图 schema 编辑器、以及任何采用该外壳的第三方插件复用）与 CardApp Studio 编辑器现在都带自动应用开关：开启后写入 / 补丁工具立即落盘，而不是渲染内联的批准 / 拒绝卡片。偏好按适配器 / 扩展各自持久化。
- **CardApp 可读取角色辅助世界书。** `ctx.getCharacterAuxWorldBooks()` 与扩展后的 `ctx.getWorldBooks()` 会在主书之外呈现通过 `world_info.charLore[].extraBooks` 绑定的书。给 `getWorldBooks` 传 `{ withSource: true }` 可获得带 `source: 'character' | 'character_aux' | 'chat' | 'global'` 标记的条目。
- **创作期与运行期作用域在三层暴露层之间完成拆分。** CardApp `ctx` 不再泄漏 `.jsonl` / sidecar 文件系统术语，聊天生命周期方法（`closeCurrentChat`、`doNewChat`、`getPastCharacterChats`、`deleteCharacterChat`）现在也通过 `getContext()` 正式暴露，第三方扩展无需深入私有内部即可管理聊天。
- Studio AI 的世界书工具统一为显式 `book_name` 参数。`list / query / get / upsert / delete_lorebook_entry` 不再回退到隐式主书；新的 `luker_card_list_world_books` 是发现入口。Studio 的 `worldinfo_list_books` 新增 `character_aux` 来源，新的 `worldinfo_search_entries` 支持在单本书内做关键词搜索而无需加载全部条目。
- 修复：当 Studio AI 在同一响应中返回正文与 tool_calls 时，聊天会先显示批准对话框（自动应用模式下为工具结果）再显示说明文字。`onAssistantText` 现在在解析后立即触发，UI 顺序与生成顺序一致。
- 修复：CardApp Studio 的静态读取（`fetchFileList`、`fetchFileContent`）与运行时的 `style.css` 拉取会静默命中浏览器 HTTP 缓存——即使服务端 `no-store` 中间件已就位，编辑器与 AI 的 `read_file` 仍可能看到过期内容。这些调用现在在客户端显式指定 `cache: 'no-cache'`。
- 修复：`charaFormatData` 在每次保存角色时都会调用 `syncCharacterBookFromWorldInfo`，把已绑定世界的完整内容序列化进 `data.character_book`——该字段本用于通过 PNG / JSON 分享角色卡，而非作为运行时镜像。过期镜像随后会让 `checkEmbeddedWorld` 为用户在别处管理的内容弹出“导入内嵌世界书”对话框。保存不再写入该镜像。
- 修复：角色替换后世界书同步弹窗中的三个 bug 叠加，把按钮变成竖排的“发送”字样，并让 AI 兜底路径在失败时破坏性地同时替换旧世界书与新世界书。CSS 作用域现在锚定到 `.luker-studio`，菜单按钮规则得以生效；破坏性替换路径也已修复，失败不再丢失内容。
- 修复：批量文件系统操作（删除并重建同名角色卡、重命名、导入）不会使内存中的最近聊天索引失效，欢迎界面的“最近聊天”因此显示过期条目——包括磁盘上已不存在的聊天，用户尝试删除时会报错。现在索引在既有的三处调用点（与角色 / 群组批量文件系统变更处理相同）一并失效。
- 修复：通过 `updateCharacterData` 对 `characters[chid].data.extensions.world` 做程序化写入后，隐藏的 `#character_world` 输入框仍保留旧值（编辑弹窗是 `display:none` 的 div，不是动态挂载的模态框，其 13 个表单属性关联始终存活）。后续基于表单的保存会把过期值原样带回。现在数据驱动写入后表单保持同步。

### 聊天保存 / 楼层同步

- **聊天写入冲突现在对用户可见。** 此前它们通过重建-差异-重试（补丁路径）或刷新-重试（追加路径）静默自动恢复——用户与测试无从察觉漂移发生，且重建路径本身基于最新服务器状态重新计算 JSON Patch diff，消息位移时会产出错误的子替换。现在会触发“聊天写入冲突”警告 toast，带端点名称 + 前三个操作摘要 + 发送时的完整性标识，发出 `CHAT_WRITE_CONFLICT` 供监测，把每个分叉索引的客户端 / 服务器 / 实时三方对比转储到控制台，并把分叉字段解析到嵌套路径而非粗糙的顶层名称——然后转入每个调用者本就作为兜底的完整保存回退。
- 修复：快照内完整性标识在入队时同步捕获，若期间另一次保存推进了服务器状态，排队的保存可能带过期完整性发出——自动插画插件在每次生图时都会踩中。现在每次发送都会在传输前一刻从实时 `chat_metadata` 刷新完整性（单聊与三条群组保存路径皆是）。
- 修复：当客户端快照携带 `Date` 对象而服务器拉取在相同位置携带等价 ISO 字符串时，分叉诊断会误报——底层值序列化为同一个 JSON 字面量，服务器的 `test` 操作本会视其为相等。诊断现在使用与服务器相同的 JSON 形状比较，线上等价的字段不再被标记。
- 修复：在落盘前一刻中止生成再点击重新生成会产生良性 409（快照 ≡ 服务器，两者均与已修正的客户端分叉）。兜底完整保存能干净地纠正它，但用户会看到误导性的“聊天写入冲突”toast。这一特定形态（`kind === 'snapshot'` 且 `divergence === null`）现在在 toast 层被抑制；诊断事件与 console.warn 仍照常发出。
- `luker_generation_id` 重试去重 token 从 `chat[N].extra` 移入以聊天路径为键的内存映射，每个条目带 60 秒 TTL。该字段不再污染持久化的 jsonl，也不再在 409 诊断中制造 `mutated:[extra.luker_generation_id]` 误报。
- 性能：外部脚本的变量更新此前每次写入都触发完整保存链。`saveMetadata` 的仅元数据路径现在跳过聊天克隆（依赖既有的实时切片回退），`saveTokenCache` / `saveItemizedPrompts` 通过 1 秒防抖加脏标记合并写入，并在 `beforeunload`、聊天重载、以及另一聊天接管 itemizedPrompts 时冲刷。
- 修复：一次上游合并把 `saveChatConditional` 重新加回 `sendMessageAsUser` 的推至尾部分支，而既有的 `appendChatMessages` 调用仍在。每条用户消息被写入两次（先按 `MESSAGE_SENT` / `USER_MESSAGE_RENDERED` 之前截取的快照打补丁，又在这些事件发出后通过追加再写一次），任何在这两个事件之间触碰 `message.extra` 的监听器都会破坏去重并在尾部产生重复的用户消息。重复调用已移除，回退设计得以恢复。

### 生成 / 任务流

- **新增面向 OpenAI 系流式的 `generateTaskStream` 分流 API。** 返回 `{ stream, result }`：一个文本 / 推理增量块的 `AsyncIterable`，外加一个 Promise，其归一化终态结果形状与 `generateTask` 相同。`jsonSchema` 在流式下可用（块携带部分 JSON，`result.jsonData` 保存解析后的对象）；`tools+jsonSchema` 互斥仍同步抛错；非 OpenAI 供应商同步抛出 `stream_unavailable`，强制用户的显式选择启用。通过 `getContext().generateTaskStream` 暴露。
- **五个内置插件新增“使用流式传输”开关**（搜索插件、聊天补全预设助手、多智能体编排、记忆图、角色卡编辑助手；默认关闭）。开启后插件的 `generateTask` 调用会包装为 `generateTaskStream(opts).result`，在长生成期间保持 HTTP 连接存活，避免慢速 API 上的空闲超时。非 OpenAI 供应商抛出 `stream_unavailable` 而非静默回退，静默回退会违背显式选择启用。
- **`generateTask` 现在默认对调用者传入的 `taskMessages` 做宏替换。** <span v-pre>`{{user}}`</span> / <span v-pre>`{{char}}`</span> / <span v-pre>`{{datetime}}`</span> / <span v-pre>`{{getvar::}}`</span> 及其他任何共享引擎宏都在请求时解析，副作用宏（`setvar` / `addvar` / ...）通过 `skipSideEffects:true` 剥除，逐次替换不会改动 `chat_metadata.variables`。创作流程（角色编辑器、世界书 diff 分析、预设编辑器、CardApp Studio AI）以 `substituteMacros:false` 退出，因为它们的职责是读取或编辑含字面 <span v-pre>`{{...}}`</span> 标记的文本。
- 思考激活现在由 `reasoning_effort` 驱动而非 `show_thoughts`。此前在 DeepSeek / Moonshot / Z.AI 上 `show_thoughts` 兼任思考的开/关开关，与其“仅可见性”的 UI 标签相矛盾。现在 `auto` 省略全部思考参数（交给供应商默认值决定），任何显式档位发送 `thinking.type='enabled'`，而 `show_thoughts` 在所有供应商上保持仅可见性语义。Gemini 2.5 Flash / Flash-Lite / Pro 的 `auto` 返回 `null` 而非 `-1`，因此 `thinkingBudget` 也一并省略。
- 提示词后处理下拉从 7 个选项收缩为 4 个（`Merge` / `Semi` / `Strict` / `Single`）。`_TOOLS` 变体仅比对应基础选项多剥离 tool 角色 / tool_calls 的少量代码——针对早已不再适用的后端的旧兼容。旧预设值（`merge_tools` / `semi_tools` / `strict_tools`）在加载时自动迁移，函数调用开关上误导性的“无工具”警告已改写，精确指向 `Single`（唯一真正不兼容的选项）。
- 修复：上游 1.17.0 把 `generateRaw` 拆成 `generateRaw` + `generateRawData`（PR #5249）时，openai 源分支对 `llmPresetName` / `apiPresetName` / `apiSettingsOverride` 的引用落进了 `generateRawData`，而加入这三个参数的参数表却留在 `generateRaw` 上。任何通过 `ctx.generateRaw` 走 openai 路径的调用者都会抛出 `ReferenceError: llmPresetName is not defined`。现在两个函数的参数表都与共享 typedef 一致。
- 修复：Claude、Gemini、Cohere 的非流式响应没有被提升为 `generateTask` 等函数期望的聊天补全形状。Claude 只包装 `content[0].text`，静默丢弃 `tool_use` 与思考块；Gemini 在候选上检测到 `functionCall` 却从未写进回复；Cohere 原样转发且完全没有 `choices[]`，`normalizeResponse` 因此抛出“openai sender returned no choices”。`generateTask` 调用方（角色编辑器、多智能体编排任务节点、记忆图）现在在非流式模式下对这三家供应商都能正常工作。
- 修复：`ToolManager.parseToolCalls` 会在全局 `function_calling` 开关处短路。开发中的 director 分支为显式提供工具的扩展调用方（director-runtime、`generateTaskStream`）加了绕过该闸门的 `force` 参数，但调用点接线缺失——用户保持开关关闭时，Claude `tool_use` 内容块会被静默丢弃于流式管线。流式 sender 现在传入 `force: normalizedTools.length > 0`，把绕过限定在真正选择启用工具调用的请求上。
- 修复：世界书 / 扩展提示词中的 <span v-pre>`\{{...}}`</span> 转义（`setvar` / `addvar` 等副作用宏的教学示例）会把前导反斜杠泄漏进 LLM 的提示词，模型会把 <span v-pre>`\{{setvar::a::1}}`</span> 原样抄回回复，宏引擎与 op-log 扫描器都尊重该转义——聊天变量静默地从未更新。花括号转义的剥离现在收束到生成请求边界。

### 消息接管（公开扩展 API）

- **新增 `createMessageEditorHandle` API 与 `GENERATE_TAKEOVER_DISPATCH` 事件。** 插件现在可以直接产出 assistant 消息正文，为该回合绕过主 LLM 分发。内核负责聊天数组的修改、DOM 重绘、`MESSAGE_UPDATED` 发出、占位符压入、生成后管线（regex AI_OUTPUT、聊天保存、工具调用检测）与 `saveReply` 路由——插件专注于内容生成。Director 模式是仓库内自带的消费者；内核本身不绑定任何插件。

### 变量

- **`setVariable(name, value, { floor? })`** 暴露于 `script.js`、`getContext()` 与 CardApp `ctx`。不带 `floor` 时直接写入 `chat_metadata.variables`（聊天作用域，在本聊天后续过程中持续存在）。带 `floor` 时通过变量操作日志向 `chat[floor].extra.var_ops` 推入一条合成的 setvar 操作，并镜像到该楼层当前 swipe——删除、滑出、滑回与分支都经重建器对账，回滚方式与 AI 写下的 <span v-pre>`{{setvar}}`</span> 字面量一致。楼层绑定路径把值强转为字符串（操作日志只承载字符串）；需要带独立提交日志的结构化按楼层状态时，改用 `ctx.lukerContext.createFloorState({ namespace })`。

### 迭代工作台（开发者 API）

- **AI 迭代弹窗框架从多智能体编排中抽出，成为可复用的 `iteration-studio` 外壳**，位于 `public/scripts/iteration-studio/`。适配器声明产物长什么样（`cloneWorkingProfile` + `getInitialProfile`）、哪些工具编辑它、提示词如何构建、如何持久化。外壳负责弹窗生命周期、对话、历史、中止、自动续轮、自动应用开关、LLM 往返与 diff 渲染（对象递归 + 内联行 / 词级 diff，带缩放与分割器浮层）。随附两个参考适配器：`orchestrator/iteration-adapter.js`（既有的 AI 迭代 UI，从 480 行减到 47 行）与 `memory-graph/schema-adapter.js`（新增——由 AI 编辑的节点类型 schema，通过 schema 编辑器旁新增的“AI 迭代 Schema”按钮打开）。第三方插件通过 `getContext().iterationStudio.{ open, defineAdapter, createSettingsBackedHistoryStore, ... }` 消费。

### 世界书

- 修复：编辑器 `<select>` 的 change 处理器把每次触发都当作切换书并清空进行中的搜索 / 过滤，而两条路径会在纯数据更新时触发它——`reloadEditor`（通过 `WORLDINFO_UPDATED`、条目开关、斜杠命令）与 `deleteWorldInfo` 的列表刷新后回调。`reloadEditor` 现在当选中仍为同一本书时直接通过 `showWorldEditor` 重载，`deleteWorldInfo` 仅在被编辑的书确实变化时才重新触发 change，删除无关的书不再清空用户进行中的搜索。

### 预设

- 修复：`persistPreset` 对比 `existingPreset` 与 `preset` 计算 JSON Patch，但像 JS-Slash-Runner 这样的扩展会从 `preset_list.presets[i]` 取引用、原地修改、再调用 `savePreset(name, sameRef)`。两个 diff 输入是同一个对象的别名，补丁永远为空，`persistPreset` 返回 `mode='noop'` 而不请求服务器——脚本删除 / 开关在刷新后静默还原。补丁路径已整体移除；保存一律向 `/api/presets/save` POST 完整预设。

### 用户备份

- **覆盖模式恢复现在是快照加回滚。** 此前恢复会先删光所有选中类别的目录（`rm -rf`），再把归档流式解压进新建的空目录——解压期间任何失败（zip 条目损坏、磁盘写满、进程被杀）都会让用户失去旧数据又留下半成品新状态，未解压的内容永久丢失。先删后写改为先重命名为 `<path>.restore-snapshot-<ts>-<hex>`；成功则丢弃快照，解压失败则清除部分写入并把快照改名回原位。解压期间磁盘占用短暂翻倍，但重命名操作本身开销极小。
- 修复：`restoreUserBackupArchive`（或 `/lan-migration/import`、`/import/data-zip`）成功后，内存中的 `recentChatIndexCache` 仍指向恢复前的文件系统快照，欢迎界面的最近聊天列表看似过期，尽管打开角色卡能看到刚导入的聊天。现在恢复完成时索引即在同样三个端点上失效。
- 修复：恢复以警告结束时，蓝色“请稍候…”进度 toast 会滞留在成功 + 警告 toast 与诊断报告模态框之后，因为 `toastr.clear` 只在 finally 块中调用，而 `await showRestoreDiagnosticReport` 会让 try 块一直存活到用户关闭模态框。现在恢复一结束就立即清除进度 toast，备份恢复与局域网迁移导入两条路径皆是。
- 备份与恢复面板中的“导入 Data ZIP”按钮与“全选 + 恢复备份”功能重复（两者都 POST 到 `/api/users/restore-backup`；唯一区别是该按钮忽略复选框并硬编码 `BACKUP_FULL_SELECTION`）。已从面板移除；从 Termux 迁移的文档已用三种语言更新，改为描述六步备份与恢复流程。新手向导中的同名按钮行为不同，予以保留。

### 生成恢复

- 进行中的恢复预览现在渲染为**聊天末尾的内联 assistant 消息气泡**，而非独立横幅，使用同样的 `.mes` 布局（头像 + ch_name + mes_text），看起来就像正在生成的消息。虚线边框的状态徽标让恢复中状态一目了然；气泡是纯 DOM，从不触碰 `chat[]`，当 `reloadCurrentChat()` 把持久化的消息画到原位时占位符随即消失。首次渲染时会滚动到可见位置。
- 客户端现在通过 SSE（`/jobs/events-stream`）流式接收恢复事件，不再每秒轮询 `/jobs/status`。服务器侧：每个任务的监听器集合在每次 `appendGenerationEvent` 与每个终态转换（`awaiting_ack` / `persisting` / `completed` / `failed` / `cancelled`）时通知订阅者；该端点先按 after_seq 起点回放，再持续输出实时 `event` / `status` 帧直至终态。客户端侧：`EventSource` 遇瞬时错误自动重连；仅 `CLOSED` 就绪态回退到重载。缺少 `EventSource` 的旧客户端或受限代理自动回退到每秒轮询。

### 管理控制台

- 会阻止下次启动的服务器配置保存与导入现在在预检阶段即被拒绝，并附本地化消息说明要修什么。检查的两条不变量为：(a) 开启 `listen` 时必须启用 `whitelistMode` / `basicAuthMode` / `enableUserAccounts` 之一（或设置 `securityOverride: true`）；(b) `protocol.ipv4` / `protocol.ipv6` 至少启用一个或设为 `"auto"`。改配置不再让你到下次启动才发现服务器拒绝启动。

### 服务器

- 修复：两条路径可能以空 stderr 终止后端。为 `backendLogBuffer` 安装的控制台包装器对每个非字符串参数运行 `JSON.stringify` 却没有 try-catch，任何 `console.*` 参数中的循环引用或 BigInt 都会让包装器抛出 `TypeError`；在 `process.on('uncaughtException')` 内部重入的包装器再次抛错，Node 随之中止，收尾的 `original(...args)` 永远执行不到。另外 Express 4 不会把异步路由处理器的 rejection 转发给 `next(err)`，在没有 `unhandledRejection` 监听器时 Node 20+ 会把该 rejection 升级为 `uncaughtException`，直接进入劫持中止路径。两处现在均有防御：包装器回退到 `util.inspect` 再到 `String()` 并隔离缓冲区簿记；显式 `unhandledRejection` 监听器确保单个失败请求不再杀死进程。

### Android 应用

- WebView 渲染进程死亡、原生崩溃、OOM 杀进程与 ANR 都会在 `MainActivity` 写入任何内容之前拆掉 activity，用户过去只会看到加载转圈与静默退出。`LukerCrashCapture` 现在在下次启动时通过 `ApplicationExitInfo`（API 30+）读取最近一次异常退出——`CRASH`、`CRASH_NATIVE`、`ANR`、`LOW_MEMORY`、`DEPENDENCY_DIED`、`SIGNALED`、`EXCESSIVE_RESOURCE_USAGE`、`INITIALIZATION_FAILURE`——对 ANR / 原生场景拉取完整 `traceInputStream`，持久化到 `filesDir/luker-last-crash-report.txt`，并在带复制 / 分享按钮的对话框中展示。按包名的时间戳防止同一报告反复弹出。低于 API 30 时轮询静默空操作。

### 更新器

- 修复：Node 20.12+ 拒绝在不带 `shell: true` 的情况下直接启动 `.cmd` / `.bat`（CVE-2024-27980 加固），导致拉取后的 `npm install` 步骤在 Windows 上以 `spawn EINVAL` 失败，尽管 `git pull` 本身成功。现在 win32 上设置 `shell: true`；参数仍为硬编码字面量，不新增 shell 注入面。

### 扩展平台

- 扩展激活现在真正并行：此前 `for` 循环内部的逐扩展 `await` 链让结尾的 `Promise.allSettled(promises)` 实际形同虚设，而局部 `promise` 变量本就只保存激活前的阶段。`.then(activate)` 与 `.catch` 现在被并入存入 `promise` 的链，循环内的 `await` 被移除，循环结尾的 `Promise.allSettled` 真正并行等待激活完成。`manifest.dependencies` 存在性检查保留。

### 杂项

- 系统头像与欢迎助手现在使用 Luker 徽标（`img/logo.png`）而非 SillyTavern 徽标；`/echo` 帮助示例已更新，不再使用的 `img/five.png` 已移除。
- 文档：新增五个扩展 API 参考页（世界书、角色、斜杠命令、宏与变量、UI 与弹窗），既有页面扩展覆盖聊天生命周期、swipe API、扩展提示词、媒体辅助函数、提示词信封检查、推理辅助函数、设置视图、底层生成原语、服务类、i18n、设置存储、调试与抓取器注册、分词、工具函数、以及符号 / 常量。新的 basics/macros 指南以 en / zh-CN / zh-TW 三语发布。所有变更已同步到全部三种语言。
- 文档：在 zh-CN / zh-TW 文档页点击顶部导航不再把读者带回英文版——导航、侧边栏、文档页脚、大纲、搜索标签、页脚与 UI 字符串现在按语言存放于各自的 `themeConfig`。一轮完整的三语审计还发现并修正了 `changelog.md` 在英文标题下通篇为中文的问题，以及 `memory-graph.md` 中的四个跨语言内部链接。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.1.2...v2.2.0


## v2.1.2 (2026-05-10)
- 修复了 CardApp Studio 无法读取角色卡信息的问题
- 优化了 CardApp Studio 提示词
- 修复了 Web 端更新冲突处理

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.1.1...v2.1.2


## v2.1.1 (2026-05-09)
- 修正了 CardApp Studio 中的文档错误并扩充了其文档

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.1.0...v2.1.1


## v2.1.0 (2026-05-09)
- **变量宏支持遍历对象**
- **CardApp Studio 支持在角色卡层面操作 regex、记忆图与多智能体编排，简化角色卡创建**
- CardApp Studio 在每次工具调用前输出的文本现在被正确保留并渲染
- CardApp Studio 现在显示 CardApp 错误日志，便于调试
- CardApp API 提供聊天世界书操作接口
- 修复了移动设备上预设组无法打开的问题
- 在 API 抽屉中新增 Embedding API 与检索 API 配置
- 向量与记忆图插件现在统一复用 API 抽屉中的 Vector API 配置
- 修复了内置插件中明文函数调用不生效的问题
- 优化了扩展更新检查的设计以减少流量消耗
- 优化了 CardApp Studio 提示词
- 修复了 CardApp Studio 不显示会话历史的问题
- 记忆图现在支持手动重新计算或补充计算向量
- 修复了修改预设时的卡顿问题
- 修复了部分移动设备上的渲染问题
- 修复了 Loop 模式下多智能体编排的问题
- Loop 编排模式现在可以调用搜索插件的搜索工具
- 新增了前端 token 估算功能

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.0.0...v2.1.0


## v2.0.0 (2026-05-07)

### ★ 文档

https://luker.cups.moe

Luker 官方文档，覆盖 Luker 的大部分改进、内置插件使用指南、插件开发规范等内容——简体中文、繁体中文与英文三语保持同步。

- 新增三语（zh-CN、zh-TW、EN）文档站，作为插件、扩展 API、CardApp 规范、记忆图等内容的统一入口
- 新增多智能体编排、记忆图、CardApp、Studio、楼层状态、按消息变量、自动迁移说明等内容的使用指南，配有截图与流程图
- 新增服务器插件开发指南与预设 API 参考
- 新增配置 / 启动文档

### ★ CardApp 与 CardApp Studio

https://luker.cups.moe/features/cardapp.html
https://luker.cups.moe/features/card-editor/studio.html
https://luker.cups.moe/features/card-editor/walkthrough.html
https://luker.cups.moe/development/card-developers.html

CardApp 是 Luker 为“前端角色卡”制定的标准形态；Studio 是面向 CardApp 作者的 AI 辅助代码编辑器——编写、编辑、运行一站完成。

- 新增 CardApp 前端角色卡：覆盖服务器 + 前端的完整套件，含 CSS 自动隔离、消息渲染管线、聊天 / 角色字段 / 世界书 API、AI 工具定义与执行循环
- 新增 CardApp Studio：代码编辑器、变更审批 + diff 视图、多会话、代码自动补全、一键 Git 回滚、热重载、完整三语 UI
- 改进了迭代工作台的提示词与工具集，让 AI 写出的代码站得住脚
- 新增世界绑定：Studio 内的 AI 可将面向 AI 的文本直接写入已绑定的世界书条目
- Studio 移动端布局：底部标签栏与响应式布局，小屏幕也能用

### ★ 多智能体编排

https://luker.cups.moe/features/orchestrator/

- 新增 Loop 模式：单个 agent 运行自己的工具循环，带默认循环提示词与“删除笔记”工具
- 编排成功时分发事件，其他插件可从该处接续
- Loop 模式可直接读写记忆图
- 持久化迭代会话
- 移除硬性迭代上限
- 新增 RPM 限流

### ★ 聊天补全预设助手

https://luker.cups.moe/features/preset-assistant.html

新增聊天补全预设助手：一个编辑预设、提示词与世界书的 AI 助手，带分步预览——预设维护一站式完成。

- 丰富工具集：默认预设创建、字段读取器、世界书开关、组装后提示词预览等
- 持久化会话历史与工具调用轨迹，可逐轮回看
- 预设修改可通过变更历史回滚

### 记忆图

https://luker.cups.moe/features/memory-graph.html

- 新增混合召回管线（图扩散 + 认知算子）
- 注入预览新增 HTML 表格渲染，并新增响应式的节点详情与注入查看器布局，支持复制与可折叠搜索
- 自动 schema 迁移：旧聊天在加载时升级，带循环保护与回退，不会卡死
- 新增两种导入模式（还原到原楼层 / 绑定到当前楼层）
- 重写事件压缩规则：摘要更紧凑，汇总（rollup）拥有独立规则集，支持跨深度扁平压缩
- 迁移到新的楼层状态核心服务，记忆按楼层对齐的 diff 提交，语义更清晰
- 新增 RPM 限流
- 优化召回提示词结构以减少 token 消耗
- 移除一批旧 schema 与无用代码路径；提示词更精简

### 楼层状态

https://luker.cups.moe/features/state-system.html

新增楼层状态——随消息楼层自然回滚与前进的状态。

- 面向插件作者的实例 API，可定位特定楼层或分支
- 分支聊天继承提交日志
- 多智能体编排、搜索插件与记忆图均已迁移到其上

### 按消息变量

https://luker.cups.moe/features/variable-op-log.html

- 新增按消息变量功能：每条消息贡献的变量变更可单独查看与管理
- 聊天中涉及的所有变量在消息被删除、swipe 或重新生成时自动回滚或更新

### 统一消息 API

https://luker.cups.moe/improvements/generation-layer.html

- 新增统一消息 API，取代零散的旧接口——为插件提供清晰的 LLM 入口

### 预设管理器

https://luker.cups.moe/features/preset-groups.html

- 新增分组系统：可折叠面板、上下文菜单、按 API 分组
- 支持嵌套子组；编辑模式下可展开 / 折叠
- 聊天补全预设与连接配置完全解耦
- 增强预设内置 regex 脚本的导入

### 提示词管理器

https://luker.cups.moe/features/prompt-groups.html

- 新增分组系统：可折叠区块、批量开关、批量启用 / 设为额外 / 移除
- 支持嵌套子组
- 新增高级提示词搜索

### 世界书

https://luker.cups.moe/basics/world-info.html
https://luker.cups.moe/features/world-info-trace.html

- 新增多世界书绑定：每个聊天可同时绑定多个世界书
- 新增覆盖所有可编辑字段的批量字段编辑工具栏，含单字段、复合（触发策略）、三态（匹配字段）与注入深度对话框；一键回滚
- 新增可配置的编辑器字段可见性，少用字段可以隐藏
- 扩充批量条目操作
- 改进搜索体验并新增高级搜索
- 完整三语；移动端布局改进

### 扩展 API

https://luker.cups.moe/development/frontend-plugin.html
https://luker.cups.moe/development/server-plugin.html
https://luker.cups.moe/development/extension-api/

- 新增扩展 API 注册表与查询
- 新增角色状态读写，状态操作不再经过 metadata 调用
- 新增一站式请求 API：连接配置、预设、消息组装、流式——一次完成
- 为 Studio 及其他上层插件新增本地 Git 能力
- 向插件暴露预设 API
- 移除旧的 extras API

### WebSocket 代理

https://luker.cups.moe/improvements/ws-proxy.html

- 新增 WebSocket 代理隧道：LLM 与图像生成请求经 WS 转发，断线自动重试，远程使用更稳定

### 重排与向量

- 新增重排序：相似度分数显示、重排端点、UI 集成、完整三语
- 新增 Jina AI 作为原生 embedding 来源
- 向量查询端点可返回原始向量

### 请求检查器

https://luker.cups.moe/improvements/request-inspector.html

- 新增请求检查器：按用户追踪 LLM 与图像生成请求，用于诊断
- 覆盖所有图像生成后端的请求追踪

### 图像生成

- ComfyUI 改用 WebSocket 而非 HTTP 轮询，WS 失败时回退到轮询

### 正则

- 新增 ReDoS 与长时间运行的正则检测，坏模式无法冻结会话
- 拖放改进；移动端长按不再误触发
- 修复正则编辑后事件未触发的问题
- 处理预设内置 regex 脚本中的无效条目

### 撤销

https://luker.cups.moe/improvements/other.html

- 为提示词与世界书条目删除新增撤销 toast——误删可恢复

### UI 现代化

- 优化抽屉面板的性能并更新其样式
- 弹窗样式与 Studio 设计系统统一
- 重新设计多智能体编排与记忆图的查看弹窗

### 性能与体验

- 新增前端性能采样开关，可捕获并精确定位卡顿
- 默认关闭自动补全，杜绝长聊天中的布局抖动；启用时节流更高效
- 削减内部不必要的对象克隆——预设编辑明显更流畅
- 上下文菜单重新定位到视口边界内，不再裁切出屏
- Android WebView 中的自适应聊天宽度
- 长聊天中批量处理 OpenAI token 计数
- 渲染时批量处理世界书条目标题的自动调宽

### 移动端

- 修复移动端虚拟键盘自动弹出及若干相关输入问题
- 预设与世界书控件的触控间距更好
- 弹窗适配小屏幕；小屏弹窗不再溢出
- Android 应用：WebView 自定义全屏、优先使用系统文件选择器 intent、更宽泛的 JSON 导入、系统主题切换不再重启

### i18n

- 完成多处翻译：变量操作面板、SD 生成 toast、世界书批量编辑、提示词分组、重排设置等

### 日志与调试

- 前端与后端所有 console 日志均带时间戳
- 新增一键调试日志导出，自动隐去密钥，可直接作为反馈发回
- 增强 Luker 持久化的日志

### 安全与认证

https://luker.cups.moe/guide/authentication.html

- 启动时为未设防的管理员账户自动配发随机密码
- 修复内置更新器在某些场景下无法运行的问题
- 局域网迁移路径绕过基本认证；Android WebView 处理 Basic Auth 提示

### 模型通道

- DeepSeek 与 Claude 支持自定义附加参数
- 在工具调用路径中处理 DeepSeek V4 推理内容
- 归一化 Claude 与 Gemini 的原生工具 schema
- 归一化 OpenAI 兼容端点 URL，接受灵活的输入格式
- 服务器端消息传输持久化扩展到更多聊天供应商
- 函数调用提示词增强，包括改进的明文函数调用提示

### 修复

- 修复多智能体编排与记忆图中 RPM 限流的语义
- 修复记忆图节点排序、注入记录更新、toast 相互覆盖、持久化内容被覆盖以及高级设置对话框滚动问题
- 修复多个提示词管理器与世界书条目样式问题
- 修复聊天绑定世界书选择器无法选择世界书的问题
- 修复 ComfyUI WS 重连重试与连接管理器 API 添加流程
- 阻止角色卡编辑器在主聊天上下文中注册工具
- 防止下拉搜索点击意外关闭抽屉
- 修复 SD 生成 toast 无法关闭、toast 相互覆盖、生成失效等问题
- 修复缺失的持久化完整性检查，避免过期数据覆盖聊天记录
- 修复 WS-Proxy 被 IP 校验错误拒绝的问题
- 修复 WS-Proxy 因关闭时机不当而中止请求的问题（应用内“无法发送消息”在 rc.2 的根因）
- 修复上游聊天在加载失败时的数据丢失 bug（现在在任何写入之前先区分“新聊天”与“损坏数据”）
- 修复流式端点静默丢弃错误的问题——现在记录完整细节并返回 500
- 修复 bootstrap 响应携带 PNG 数据导致载荷过大的问题
- 修复推理斜杠命令在初始化期间未注册的问题
- 修复 OpenAI 错误处理与提示词引用、提示词 token 上限误算以及 SD 异常处理
- 修复 blob/iframe 下载处理
- 保存角色表单时保留自定义字段
- 修复宏转义：转义在多条路径上保持有效；副作用宏不再在提示词组装期间重复触发
- 修复切换分支时分支聊天保存到错误目标文件的问题
- 修复 persona 解绑状态不持久化与迁移头像文件名未保留的问题
- 修复绑定预设被清空时 OpenAI 卡死的问题
- 修复下拉删除按钮在 WebView 触摸下无响应的问题
- 修复角色卡校验在合并卡归一化之前就生效的问题
- 修复多个连接配置切换问题

### 重构与上游同步

- 同步至上游 SillyTavern 1.18
- 角色卡运行时与存储改为 v2 优先（移除 v1 回退）；旧卡自动迁移
- 移除内置 summarize 扩展（由记忆图取代）
- 移除旧的重定向路由与废弃的兼容垫片
- 移除世界书字符串回退，改用条目数组
- 将单体扩展拆分为内部模块

### 新贡献者
* @Youzini-afk 在 https://github.com/funnycups/Luker/pull/1 中做出了第一次贡献
* @1432647 在 https://github.com/funnycups/Luker/pull/3 中做出了第一次贡献
* @atonal519 在 https://github.com/funnycups/Luker/pull/5 中做出了第一次贡献

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.32.1...v2.0.0

## v1.32.1 (2026-03-21)
- 更新管理器中开关图标的启用状态

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.32.0...v1.32.1

## v1.32.0 (2026-03-21)
- 将全局世界书管理移入抽屉，附带置顶世界书、启用摘要、标签搜索与批量控制
- 新增批量世界书条目转移，并通过专用拖动指示器实现更安全的自定义排序
- 改进世界书管理器的性能与渲染稳定性
- 新增聊天人设变更提醒，并使聊天/角色人设绑定在切换聊天时保持稳定
- 为角色卡编辑助手加入持久化对话历史
- 为编排器加入持久化迭代历史与基于 diff/patch 的变更跟踪
- 允许在保存进行中时安全切换聊天与执行聊天文件操作，同时正确限定删除新聊天操作的范围，并减少移动端意外触发楼层切换
- 改进创建世界书条目的搜索指引，包括来源作品处理、常驻注入条目，以及消息编辑后刷新缓存
- 在角色绑定预设中保留正则扩展，并提升提示词/正则编辑器的响应速度

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.31.0...v1.32.0

## v1.31.0 (2026-03-20)
- 将纯文本函数调用重试设置保存到指定的 API 预设
- 搜索插件中的网页访问优先使用 jina reader
- 避免重命名时聊天文件夹冲突
- 修复图库检索
- 对无效脚本的编辑器渲染进行防护
- 停止依据隐藏消息修剪图
- 中止生成后恢复发送控件
- 防止欢迎界面与恢复的聊天混杂
- 提升预设切换性能
- 限制日志查看器的渲染预算
- 为日志查看器添加搜索
- 将预设与正则的重新排序限制为实际拖动把手
- 在代理分块间保持 utf-8
- 处理带末尾空格的世界书文件名
- 在预设操作按钮之间添加间距

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.30.1...v1.31.0

## v1.30.1 (2026-03-18)
- 修复启动加载问题
- 优化纯文本函数调用参数相关文档

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.30.0...v1.30.1

## v1.30.0 (2026-03-18)
- 完善插件复用预设时清除世界书数据相关的开发文档。
- 记忆图、编排器与搜索插件现在可手动禁用在请求中包含世界书数据的功能。
- 优化搜索插件，要求搜索后生成的世界书条目使用标准 YAML 格式，提升条目质量。
- 在用户设置中添加前端日志开关（默认关闭），防止插件打印过多日志；调试时可开启以查看错误信息。
- 优化预设保存性能。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.29.1...v1.30.0

## v1.29.1 (2026-03-18)
- 为记忆图增量持久化压缩进度
- 在重置或导入记忆图前停止运行时工作
- 为记忆图的定时更新添加 single-flight 合并
- 避免手机上的固定背景渲染
- 优化默认记忆图 Schema 与提示词
- 防止 App 在屏幕方向改变时重启

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.29.0...v1.29.1

## v1.29.0 (2026-03-17)
- 为插件弹窗添加重新生成
- 跨轮持久化弹窗中的工具轮次
- 角色编辑器支持问候语字段

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.28.0...v1.29.0

## v1.28.0 (2026-03-17)
- 为编排器添加按 agent 的聊天预设路由
- 为纯文本函数调用添加可选自动重试
- 为记忆图添加事件时间字段默认值
- App 启动时刷新正则列表
- 优化 App 启动
- 取消编辑时恢复 message_updated 事件
- 避免取消编辑时清空翻译

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.27.1...v1.28.0

## v1.27.1 (2026-03-16)
- 修复快速回复中的错误
- 议程模式下，编排器中的规划器现在可设置 API 预设
- 修复正则状态更新

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.27.0...v1.27.1

## v1.27.0 (2026-03-16)
- 新增插件专用正则
- 启动时恢复 UI 状态
- 改进开发文档
- 修复密钥弹窗
- 记忆图采用文件导入导出
- 为记忆图添加节点搜索
- 编排器支持按 agent 的 API 预设
- 修正启动页 GitHub 图标链接
- 优化编排器生成提示词
- 纯文本函数调用改用 XML 模型
- 写入后使过期的缓存读取失效

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.26.1...v1.27.0

## v1.26.1 (2026-03-16)
- 修复预设切换
- 优化纯文本函数调用模型

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.26.0...v1.26.1

## v1.26.0 (2026-03-15)
- 一系列前端与后端的性能和缓存优化，包括世界书渲染优化、启动首屏优化、最近聊天缓存、diff 后端优化、前端设置缓存，以及最大化并发请求
- 优化搜索插件的提示词；请在插件设置中点击重置
- 优化搜索插件的执行逻辑
- 将多智能体编排的默认注入深度重置为 0
- 为角色卡编辑器弹窗添加中断按钮
- 为多智能体编排引入议程模式：在该模式下，规划器动态决策并调用 agent 进行编排，规划器可自由运作，不受固定编排顺序的约束
- 编排器现在可在角色卡级别持久化编排类型（agenda/spec/single）
- 修复角色卡编辑器在更新角色卡后触发错误的问题
- 优化 emoji 名称的处理
- 为前端日志显示添加时间与数量筛选
- 禁用记忆图时立即停止进行中的更新
- 搜索插件结果现在支持随用户聊天历史一同回滚
- 修复切换 API 预设时反向代理未能自动加载的问题
- 优化纯文本函数调用的设计，以更好地对齐 Toolify 的通用函数调用模型

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.25.3...v1.26.0

## v1.25.3 (2026-03-13)
- 修复重新生成时助手消息重复的问题

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.25.2...v1.25.3

## v1.25.2 (2026-03-12)
- 遵循召回世界书的注入设置
- 优化编排器生成提示词
- 注入设置变更时同步持久世界书
- 在事件中添加楼层切换元数据
- 修复楼层切换期间记忆图的问题
- 将沉浸模式开关移入用户设置
- 确保编辑器在保存后关闭
- 修复 App 内 jsonl 与正则的选择问题
- 修复钩子顺序中第三方扩展的问题
- 为钩子顺序添加更多事件

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.25.1...v1.25.2

## v1.25.1 (2026-03-11)
- 改进简体与繁体中文的 i18n 覆盖率
- 修复 App 无法导入图片的问题
- 切换预设时保留停止字符串
- 修复消息编辑时偶发的 UI 混乱
- TTS 现在会在后端记录请求详情并捕获错误
- 修复部分设备上 App 无法导出文件的问题

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.25.0...v1.25.1

## v1.25.0 (2026-03-11)
- 编排器注入评审节点的反馈
- 为 App 添加 i18n
- 修正受正则影响的消息保存
- 撤销时保留世界书激活状态
- 为角色卡添加撤销功能

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.24.0...v1.25.0

## v1.24.0 (2026-03-10)
- 允许在未选择 API 预设的情况下修改函数调用模式
- 角色卡编辑器现在提供世界书搜索与检索工具，而非直接嵌入整本世界书
- 修复抽屉 UI 显示
- 在角色卡范围内正确覆盖记忆图的高级设置
- 为编排新增评审节点类型，该节点可审查先前节点，并对不理想的部分触发重试
- 删除聊天、预设或世界书时，现在会提供简短的撤销提示
- 角色卡导出将包含最新绑定的世界书
- 修复输入法打开或关闭时的卡顿问题
- 为编排添加可视化流程图，以观察整个过程
- 单 agent 编排模式下现在可查看编排结果
- App 允许在状态栏通知中自定义端点；非本地端点不会启动本地服务
- 消息编辑事件提供更详细的元数据
- 编排结果现在会随用户消息的更改与删除一同回滚
- 优化增量更新端点，减少不必要的完整保存
- 记忆图的错误与警告提示现在会持久显示

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.23.0...v1.24.0

## v1.23.0 (2026-03-09)
- 在前端管理后端插件
- 优化插件作用域的正则与 API
- 修复编排器结果注入
- 修复插件的作者注释注入
- 为插件开放搜索 API
- 新增 SearXNG 与 Brave 作为搜索提供方
- 即使网页抓取失败，搜索 agent 循环也会继续
- 搜索抓取失败时返回详细错误

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.22.0...v1.23.0

## v1.22.0 (2026-03-08)
- 切换聊天时会同步更新记忆图与搜索插件的状态。
- 中断记忆图更新不会导致图数据丢失，部分处理的变更会被保存。
- 修复了纯文本函数调用的若干回调问题。
- 优化了 DuckDuckGo 搜索结果的解析。
- 取消消息编辑不再错误地触发消息更新事件。
- 记忆图更新被中断时会出现提示通知。
- 优化了搜索插件的提示词。
- 优化了与记忆图节点和更新相关的提示词；可在 Schema 与高级设置中手动重置为最新默认值。
- 新增了聊天分支事件。
- 聊天分支会将记忆图数据同步到新聊天。
- 提示词管理器现在可搜索运行时提示词，例如聊天历史中的消息。
- 编辑消息不再中断记忆图更新。
- 修复并统一了记忆图、编排与搜索插件的注入设置。
- Luker 现在可通过指定前端与后端插件路径启动。
- App 的前端与后端插件现在直接从 Android/data 读取并使用。
- 修复了关闭记忆图后消息被错误隐藏的问题。
- 搜索插件现在与编排一样，纳入两阶段查询及相应提示词。
- 修复了插件请求重新扫描世界书的工作流。
- 修复了搜索插件无法注入搜索结果的问题。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.21.0...v1.22.0

## v1.21.0 (2026-03-07)
- 打开抽屉时刷新正则脚本列表
- 稳定图像生成跟踪，并在最后一个活跃任务停止后清除生成提示
- 切换聊天预设时保持 API 配置稳定
- 支持插件在激活后重写世界书的钩子
- 规范编排器与记忆图的运行时世界书载荷处理，包括 Quick Build 上下文
- 以 Toolify 风格流程统一核心与扩展的函数调用运行时
- 在 API 抽屉中添加主聊纯文本函数调用开关
- 支持调用方自有的无工具处理、纯文本 prompt_json 响应，以及更清晰的多工具纯文本提示词
- 保留对 array/parts 载荷的助手文本提取，并规范流式纯文本工具调用
- 将工具结果回放标准化为 assistant/tool 消息
- 在编排器中添加节点搜索与知识迭代，支持聊天状态持久化
- 折叠较长的编排迭代消息，并隐藏自动模拟载荷
- 简化默认编排器提示词模板
- 新增编排研究记录查看器弹窗
- 将「胶囊」措辞更名为「编排结果」
- 允许编辑最新的编排结果
- 将网页搜索与编排器解耦
- 在角色卡编辑助手中添加集成的网页搜索工具流程
- 新增 DDG 提供方，并将搜索插件 API 从全局工具注册中解耦
- 明确搜索插件的主模型可见性开关，支持基于预设的 agent 选择器，添加可取消的搜索提示，并在重新生成时复用请求前结果
- 为记忆图角色 Schema 添加默认特质列
- 在记忆图中新增可配置的召回注入位置
- 在记忆图提取中排除最近的助手轮次
- 支持将记忆图导入为聊天基线
- 增强记忆图在聊天变更回滚、召回中止、重新生成复用与过期内容清理方面的稳定性
- 在记忆图中持久化增量操作日志
- 使用共享的插件世界书，并在运行时创建后刷新世界书列表
- 为用户备份添加安全的局域网迁移流程，并在下载前清除进度提示
- 插件中止后继续生成，并在客户端取消时中止进行中的后端请求

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.20.0...v1.21.0

## v1.20.0 (2026-03-02)
- 记忆图将保存持久节点

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.19.0...v1.20.0

## v1.19.0 (2026-03-02)
- 清除最后一次图像生成的生成提示
- 优化编排提示词
- 稳定记忆图批量删除消息后的状态
- 在 API 预设中保存额外参数
- 修复编排器角色范围下删除预设的问题
- 支持与预设关联的世界书
- 新增提示词搜索
- 预设导入导出始终剥离连接字段

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.18.0...v1.19.0

## v1.18.0 (2026-03-01)
- 避免将编排器的 agent 超时应用于 agent 生成
- agent 生成的 JSON 解析错误将触发重试
- 修正编排器的预设移除
- 中止时清除图像生成的生成提示
- 修正正则列表渲染
- 防止重试竞争时重复插入消息

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.17.0...v1.18.0

## v1.17.0 (2026-02-28)
- 图像生成提示现在添加中断生成的按钮
- 编排器生成模型可将全局编排作为参考查看
- API 预设的反向代理现在随预设本身一同保存
- 正则插件现在提供插件专用正则。任何插件/脚本均可通过 Luker 界面添加
- 编排器现在使用插件正则功能处理消息隐藏

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.16.1...v1.17.0

## v1.16.1 (2026-02-27)
- 将 config.yaml 保存到外部存储

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.16.0...v1.16.1

## v1.16.0 (2026-02-27)
- 编排器现在注入最新节点的纯响应
- 为编排器生成新增占位符使用指南
- 稳定编排器重新生成的缓存复用
- 为编排器新增 CoT
- 支持 Discord OAuth 作用域
- App 数据迁移至外部存储

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.15.0...v1.16.0

## v1.15.0 (2026-02-26)
- 修复发送消息时的问题
- 新增聊天消息管理
- 关闭/重新加载本页面前新增警告

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.14.0...v1.15.0

## v1.14.0 (2026-02-25)
- 修复作者注释、对话示例等内容无法被插件请求复用的问题。
- 从记忆图默认 Schema 中移除「thread」。
- 切换预设时，若有未保存的更改，将提示你保存。
- 切换预设或将其从提示词顺序中移除等操作，现在会触发撤销提示，可在短时间内还原更改。
- temperature 等预设配置现在默认折叠，以防意外修改。
- 优化全屏模式下的输入法问题。
- 修复记忆图中的聊天楼层裁剪功能。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.13.1...v1.14.0

## v1.13.1 (2026-02-24)
- 优化记忆图提示词
- 改进 Luker API 文档

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.13.0...v1.13.1

## v1.13.0 (2026-02-24)
- 允许在图检查器中删除节点
- 更新默认事件 Schema 与压缩提示词
- 压缩汇总中保留 Schema 字段
- 在最近注入视图中显示动态召回内容
- 为记忆图添加 Schema 压缩规则与 thread 默认过滤
- 修复重新生成
- 增强 App 沉浸式布局稳定性
- 修复 App 中大备份文件的问题
- 为繁重操作改用异步 diff

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.12.1...v1.13.0

## v1.12.1 (2026-02-23)
- 修正记忆图自动压缩

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.12.0...v1.12.1

## v1.12.0 (2026-02-23)
- 优化编排器角色范围的使用
- 兼容依赖错误时序的脚本与插件
- 修复插件所用 API 预设中的认证问题
- 跟随上游 SillyTavern 更新至 7ffb28f，内容如下

### 亮点
- 提升大型聊天中的消息渲染性能（`printMessages`、批量前插、编辑替换路径）。
- 迁移 Macros 2.0 核心及后续运行时/自动补全修复。
- 升级媒体管线，新增 `/api/image-metadata`、后台元数据与排序支持。
- 扩展 SD/媒体能力：Z.AI GLM-Image、Pollinations API 更新、stable-diffusion.cpp 后端、更佳的生成进度/中止体验。
- 同步 OpenRouter、NanoGPT、Moonshot、Z.AI 与打标工具的模型/提供方更新。
- 新增向量斜杠命令控制，并改进世界书命令诊断。

### Luker 原生变更
- `b9dc9c278` 新增 Z.AI GLM-Image 模型支持与尺寸规则。
- `917c25564` 新增 SD 生成进度指示器与中止体验改进。
- `5ae4d365b` 迁移 Pollinations 图像 API（认证与响应格式）。
- `f26567c97` 新增 stable-diffusion.cpp 后端支持。
- `7befcdf23` 避免楼层切换时重复追加媒体。
- `d804ee975` 新增最小提示词处理选项。
- `a57a1d68b` 新增 NanoGPT 推理力度控制。
- `33a7eca6d` 为图像生成请求添加 OpenRouter 请求头。
- `e023ea2b1` 新增向量存储斜杠命令。
- `a2b0cefb2` 新增可配置的 Gemini 思考签名注入。
- `c6451e254` 映射 Moonshot 与 NanoGPT 的推理控制。
- `b854572e2` 改进世界书斜杠命令警告与重复命名。
- `dabd9bd23` / `c8fca6e4f` / `424c118e7` / `17d87e939` 完成 Macros 2.0 迁移工作。
- `564d1d84e` / `c175e43c3` / `e95f192a4` 改进消息渲染/编辑/索引行为。

### 上游同步
- 修复包含冒号密码的 HTTP Basic Auth 认证。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/df0e1256e67276f203bb2dc93ba747bb18df8f26
- 使 CORS 中间件可配置。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/10e08f0e3df3bd22a00a017db772cd8b0258ecc3
- 防止切换角色/群组时意外覆盖聊天。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4e5cb9c44f99f6ecd886a7c4a26defb6b8ed06f6
- 新增置顶最近聊天。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/1ff98e76f8a80f0d9025b2cc288bab8045c25335
- 工具调用递归时保留用户输入。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/9714374749b0bf1193f10af1b83695ab38147b7c
- 为扩展开放角色更新 API。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/ef25a0365014fe7c298e34b207907f390647d0d8
- 为 `isValidImageUrl` 添加针对空值头像的防护。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/3efe809d274f71c8b34e58b97255ea1d6a319f57
- 修复带前缀 ID 时 NanoGPT Claude 缓存检测。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4672647293b616ba99a87bfe3dbeeb76d5f3ad7d
- 根据应用语言设置 HTML `lang` 属性。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/50e566ee0dde408065d2b05a1c0c0eedb019052e
- 同步 OpenRouter 提供方列表。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/300912237d0e53ae3725685b79eccc7b22765bf2
- 为 `clearChat` 添加 `clearData` 选项。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/b64c279473be4b17be16b52caf3ce9dbf65b8eeb
- 改进搜索解析并恢复跨消息文本搜索。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/3f8acaad4e2ac6251e9b714726eed180c2de7fb7  
  上游：https://github.com/SillyTavern/SillyTavern/commit/5c62cf4a6ef7d3b73d9ac746c2b08e1ab026e8a9
- 改进欢迎界面滚动行为。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/e5c14af76d4d4d99638414f7a09ad71587549610
- 改进宏解析时的楼层切换同步保护。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/bee4d9a8183f4aecf326b8d6e2b1d9cfdca96dd3
- 为向量存储添加 NanoGPT 嵌入支持。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/5832cb8b07f8e7c62880b77be49b765dccb6fe49
- 改进 ComfyUI 重命名体验与样式保存默认行为。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/23ba3e5bb2e7aad59d0912b2b026a14052936f1b  
  上游：https://github.com/SillyTavern/SillyTavern/commit/8e911af031d2ac609b9f6f1acee72810aa5521e4
- 新增 Claude Opus 4.6 选项。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/39c8eb343c279b8e1293caff7c357caa3ba93b07
- 为空查询添加 null 匹配器优化。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/ad88acc9805a14bf67987f9018b9dd83ff906c27
- 新增后台元数据填充、排序与缩略图修复。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/4550afd4cce9de4129af66495d6e56f35f5381f0  
  上游：https://github.com/SillyTavern/SillyTavern/commit/788ed3d32cf2f2698ea84f189f70f8df3ba359ed  
  上游：https://github.com/SillyTavern/SillyTavern/commit/1e49f3d4f84cf855cf7406ff3e146f27427b6ee0  
  上游：https://github.com/SillyTavern/SillyTavern/commit/266f3ade0effd08a45448f93fda0f54e1fca11aa
- 提升 `printMessages` 与 `getGroupPastChats` 性能；以 fetch 替换 jQuery AJAX。  
  上游：https://github.com/SillyTavern/SillyTavern/commit/2d1a96f91d675c618e7fc9832cda3bea5c2ac8d4  
  上游：https://github.com/SillyTavern/SillyTavern/commit/68d4da1c83d74a53f77a28ca0e0aae5c26aa9d7b  
  上游：https://github.com/SillyTavern/SillyTavern/commit/8a32b72dfea21a678864c561cd74ae3c4caab82e

### Macros 2.0 上游参考集
- https://github.com/SillyTavern/SillyTavern/commit/e9bedadc0
- https://github.com/SillyTavern/SillyTavern/commit/0dcd9906b
- https://github.com/SillyTavern/SillyTavern/commit/dbc4fe611
- https://github.com/SillyTavern/SillyTavern/commit/81414724b
- https://github.com/SillyTavern/SillyTavern/commit/cd0627bfe
- https://github.com/SillyTavern/SillyTavern/commit/b453fdc5d
- https://github.com/SillyTavern/SillyTavern/commit/e40b31b06
- https://github.com/SillyTavern/SillyTavern/commit/7331dba05
- https://github.com/SillyTavern/SillyTavern/commit/3047045d3
- https://github.com/SillyTavern/SillyTavern/commit/5c2a02a12
- https://github.com/SillyTavern/SillyTavern/commit/f8c373f55
- https://github.com/SillyTavern/SillyTavern/commit/0b529290a
- https://github.com/SillyTavern/SillyTavern/commit/42155eceb
- https://github.com/SillyTavern/SillyTavern/commit/ca60ba148
- https://github.com/SillyTavern/SillyTavern/commit/9ff9d5967
- https://github.com/SillyTavern/SillyTavern/commit/9f4449973
- https://github.com/SillyTavern/SillyTavern/commit/953d9f34c
- https://github.com/SillyTavern/SillyTavern/commit/06b77ec94
- https://github.com/SillyTavern/SillyTavern/commit/26d495f45
- https://github.com/SillyTavern/SillyTavern/commit/6f5032f20
- https://github.com/SillyTavern/SillyTavern/commit/bee4d9a81

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.11.0...v1.12.0

## v1.11.0 (2026-02-23)
- 为存在冲突的插件添加强制更新
- 删除角色时，仅在世界书存在时才提示删除世界书
- 修复角色更新期间世界书分析的问题

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.10.0...v1.11.0

## v1.10.0 (2026-02-22)
- 新增移动端模型元数据提示
- 明确记忆图与编排器的描述
- 修正记忆图与编排器最新一次运行的显示逻辑
- 修复 App 内扩展升级的问题

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.9.2...v1.10.0

## v1.9.2 (2026-02-22)
- 修复全局扩展的备份与恢复。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.9.1...v1.9.2

## v1.9.1 (2026-02-22)
- 避免临时注入提示词丢失

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.9.0...v1.9.1

## v1.9.0 (2026-02-22)
- 修复部分插件中的世界书激活
- 插件现在可复用 `/inject` 命令中的提示词
- 记忆图现在可隐藏早期消息
- 优化 SillyTavern 数据迁移引导
- 管理员现在可在恢复与备份中备份全局扩展
- 修复管理面板缺失的问题
- 为 Claude 与 Vertex 端点添加自动模型获取
- 为 Chat Completions 添加自定义模型

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.8.2...v1.9.0

## v1.8.2 (2026-02-22)
- 增强记忆图提示词

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.8.1...v1.8.2

## v1.8.1 (2026-02-22)
- 修复记忆图中的函数定义

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.8.0...v1.8.1

## v1.8.0 (2026-02-21)
- 允许 App 上的前端脚本调用全屏 API

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.7.0...v1.8.0

## v1.7.0 (2026-02-21)
- 修复记忆图中的错误
- 在记忆图中添加角色范围高级设置
- 添加与生成相关的通知
- 修复与完整性变更相关的补丁错误
- 在感知预设的请求中保留世界书注入
- 优化正则重新加载策略
- 新增原生沉浸式全屏

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.6.1...v1.7.0

## v1.6.1 (2026-02-20)
- 修复记忆图中的错误

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.6.0...v1.6.1

## v1.6.0 (2026-02-20)
- App 启动时自动探测可用端口

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.5.1...v1.6.0

## v1.5.1 (2026-02-20)
- 避免重新生成时快照丢失。
- 增强扩展安装的健壮性。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.5.0...v1.5.1

## v1.5.0 (2026-02-20)
- 修复聊天意外重新加载的问题
- 为 App 添加运行时通知

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.4.0...v1.5.0

## v1.4.0 (2026-02-20)
- 增强 SillyTavern 数据迁移指南。
- 避免 App 上消息消失。
- 对相同消息与重新生成复用编排器与记忆图扩展的结果。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.3.1...v1.4.0

## v1.3.1 (2026-02-20)
- 增强正则扩展的边界条件处理。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.3.0...v1.3.1

## v1.3.0 (2026-02-20)
- 修复移动端错误。
- 管理员现在可在管理面板编辑 config.yaml。
- 防止移动应用升级时扩展丢失。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.2.0...v1.3.0

## v1.2.0 (2026-02-20)
- 在提醒弹窗中授权后，Luker 现在会使用 git 自动升级或下载 apk。
- 现在可在日志设置中查看前端日志。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.1.0...v1.2.0

## v1.1.0 (2026-02-20)
- 现在可在备份与恢复设置中直接从 ST 数据 zip 迁移数据。
- 后端日志现已对管理员开放。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v1.0.0...v1.1.0

## v1.0.0 (2026-02-20)
### 核心优化
- 主要保存链路切换为 patch-first（RFC 6902）模型，显著减少重复整文件重写，节省流量并提升可靠性。
- 增强了增量保存的冲突处理与整体运行稳定性。
- 聊天补全预设与 API 预设解耦，模型路由更灵活。
- 新增角色范围绑定能力，可绑定用户人设与预设，且不影响全局配置。
- 角色范围的人设与预设绑定会随角色卡一起导入导出，便于创作者分发。
- 新增 GitHub / Discord OAuth 登录支持。
- 新增用户存储限额控制与默认配额分配。

### 世界书
- 新增世界书激活链路追踪，可查看某条目为何被激活、由谁触发。
- 世界书保存流程升级为 patch-first 增量更新。

### 内置功能
- 多智能体编排器：支持串行/并行阶段编排，支持 AI 自动生成编排方案，并提供可读的差异审批流程。
- 多智能体编排配置支持角色卡范围，并支持导入导出。
- 记忆图插件：优化图结构记忆抽取与关联，支持迭代召回、最近轮次局部重建，并改进图展示效果。
- 记忆图支持角色卡范围的 Schema 设置，并支持当前聊天记忆图导入导出。
- 角色卡编辑助手：支持 AI 编辑角色字段与世界书内容，提供差异审阅、审批与历史回滚。
- 在「角色卡替换/更新」后，会弹出引导面板，询问你是保留当前世界书、直接替换为新世界书，还是使用 AI 对比新旧世界书后更新。
- diff 体验增强，支持逐行差异放大查看。

### 安卓 App
- 新增 Luker 安卓 App 运行支持。
- 提升 WebView 文件/媒体交互能力（SAF 选取、blob/data 下载处理、权限桥接）。
- 支持在安卓 App 内安装扩展插件。

### 备份与恢复
- 新增内置备份/恢复功能，支持按数据类别选择。

**完整更新日志**：https://github.com/funnycups/Luker/commits/v1.0.0
