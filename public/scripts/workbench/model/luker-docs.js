// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 内置的 Luker 功能知识与排查速查索引（纯数据与纯检索，无 DOM、无网络）。
// 供「问问」在回答「Luker 某功能怎么用 / 在哪开 / 为什么不生效」时按需检索，
// 避免模型仅靠旧版 SillyTavern 印象猜测 Luker 独有特性。

/**
 * Luker 功能速查条目列表，内容对齐 docs/zh-CN/ 对应文档。
 * 每条包含：id、title、category、keywords、entryPoint、scope、summary、troubleshooting、docPath。
 */
export const LUKER_DOCS = Object.freeze([
    {
        id: 'workbench',
        title: '工作台（Workbench）',
        category: '核心工作区',
        keywords: ['工作台', 'workbench', '总览', '问问', 'ai 迭代', 'ai迭代', '改动记录', '小建议', 'alt+w', '胶囊', 'plugin-only', '运行面板', '未保存'],
        entryPoint: '输入框旁魔杖菜单 → 工作台；或点击右下角常驻胶囊；或按快捷键 Alt+W',
        scope: '工作台设置跟随账号（extensionSettings.workbench）；会话按当前聊天/全局隔离',
        summary: 'Luker 原生统一工作区，集成总览（最近一次提示词 token 分解与本地规则小建议）、问问（只读诊断助手）、AI 迭代（预设/角色卡/世界书/记忆图/记忆结构/编排/图像生成的对话式差异编辑）、改动记录（会话内逐条撤销）以及嵌入式记忆图、编排、图像生成面板。',
        troubleshooting: [
            '工作台 AI 配置支持「共用 → 插件设置 → 单独指定」三级解析；默认优先选用 plugin-only 预设（如已导入），否则回退当前预设。',
            '「问问」严格只读且默认自动脱敏 API 密钥与 URL；修改配置请通过回答底部的「去改 XXX」跳转到对应 AI 迭代工作台。',
            '在群聊中工作台按「未选择单一角色卡」处理，角色卡专属字段与单卡绑定项不可用。',
        ],
        docPath: 'docs/zh-CN/features/workbench.md',
    },
    {
        id: 'memory-graph',
        title: '记忆图（Memory Graph）',
        category: '长期记忆',
        keywords: ['记忆图', 'memory-graph', 'memory', '记忆', '忘事', '忘记', '常驻注入', 'core', 'focus', '召回', '压缩', '合并', '回溯', 'schema', '记忆结构', '节点', '向量', 'rag'],
        entryPoint: '工作台 → 记忆图（含图谱/时间线/数据表/记忆结构/设置），或 扩展 → 记忆',
        scope: '记忆节点数据按聊天独立；记忆结构（Schema）与高级设置支持「全局」或「当前角色单独覆盖」两种作用域',
        summary: '后台自动从对话提取带类型的结构化记忆节点与关系，并在生成前分成两路注入提示词：core（常驻注入，受回溯楼层上限与压缩控制）与 focus（按需召回，支持 LLM 规划或 RAG 向量召回）。',
        troubleshooting: [
            '角色「突然忘了某件事」排查顺序：先用 wb_read_memory(part="search", query=...) 查图谱里有没有该节点 → 若无，检查提取是否开启/提取间隔/最近请求是否报错；若有，看它是否被归档、是否超出常驻回溯楼层上限（persistentInjectionMaxSeqDistance）且未被本次 focus 召回。',
            '常驻注入 token 暴涨排查：查 wb_read_memory(part="summary") 看 unmerged 未合并事件数、自动层次压缩是否开启，以及 maxSeqDistance 是否为 0（不限回溯）。',
            '排查高占用具体条目：调 wb_read_memory(part="core") 或 wb_read_memory(part="focus") 直接查看上次实际注入文本。',
        ],
        docPath: 'docs/zh-CN/features/memory-graph.md',
    },
    {
        id: 'orchestrator',
        title: '多 Agent 编排（Orchestrator）',
        category: '多智能体',
        keywords: ['编排', 'orchestrator', 'orch', 'spec', '流水线', 'single', '单助手', 'agenda', '调度', 'loop', '循环', 'director', '导演', '胶囊', 'capsule', '笔记', 'notes', '自定义工具', '运行面板'],
        entryPoint: '工作台 → 编排（含流程/运行/历史/统计/准备阶段/设置/笔记），或 扩展 → 多智能体编排',
        scope: '方案库支持全局与角色卡作用域；Agent 提示词预设解析优先读角色卡内嵌预设；剧情笔记属于当前聊天',
        summary: '在主模型动笔前（或由 Director 模式直接接管写作）调度多个 AI 助手分工协作。支持 5 种模式：Spec（固定阶段流水线）、Single（单助手轻提醒）、Agenda（规划者动态派发待办）、Loop（单 Agent 多轮调用工具）、Director（写作团队直接完成正文并评审修订，主模型不参与）。非 Director 模式通过「编排胶囊」按配置深度注入主模型。',
        troubleshooting: [
            '编排慢或失败：调 wb_read_orch(part="last_run") 看具体哪位助手/哪一轮耗时最长或报错，再配合 wb_list_requests / wb_read_request 查看上游请求详情。',
            '回复风格突然大变或包含隐形引导：调 wb_read_orch(part="capsule") 检查注入的编排胶囊内容，并核对当前是否为 Director 接管模式。',
            '伏笔或待办剧情追踪：调 wb_read_orch(part="notes") 查看当前聊天的编排笔记。',
        ],
        docPath: 'docs/zh-CN/features/orchestrator/index.md',
    },
    {
        id: 'image-generation',
        title: '图像生成与 AI 插图（Image Generation / SD）',
        category: '图像生成',
        keywords: ['生图', '图像生成', 'sd', 'stable-diffusion', 'ai 插图', '插图', 'comfyui', '工作流', 'workflow', '角色库', '画室', '定妆', '参考图', '占位符'],
        entryPoint: '工作台 → 图像生成（画室 / 角色库 / 运行轨迹），或 扩展 → 图像生成，或 魔杖菜单 → 图像迭代工作台',
        scope: '生图后端与预设为全局设置；角色库档案全局共享；运行轨迹记录近期正文插图与探索运行',
        summary: '统一本地与云端生图后端（ComfyUI、WebUI、云端多供应商等）、跨后端角色与画风参考图协议、双 Agent 协作的 AI 正文插图、全局角色库档案，以及支持自由画图与角色定妆的交互式画室。',
        troubleshooting: [
            '生图或 AI 插图失败：调 wb_read_sd(part="summary") 与 wb_read_sd(part="last_run")，优先检查绑定的连接配置是否已被删除（brokenConnectionProfile）、后端能力（capabilities）与 ComfyUI 节点/占位符配置（workflows）。',
            '生图人物走形或服装不对：调 wb_read_sd(part="characters") 和 wb_read_sd(part="presets") 检查角色库标签、默认服装和插图提示词预设。',
        ],
        docPath: 'docs/zh-CN/features/image-generation.md',
    },
    {
        id: 'world-info-and-trace',
        title: '世界书与世界书激活链路追踪（World Info & Trace）',
        category: '提示词与设定',
        keywords: ['世界书', 'lorebook', 'world info', 'world-info', '激活', '触发', '没触发', '未激活', '追踪', 'trace', '扫描深度', '常驻', '关键词', '预设世界书', '辅书'],
        entryPoint: '顶部导航栏 → 世界书；每个条目右上角路线图标可打开「激活链路追踪」弹窗',
        scope: '支持全局世界书、角色主书、角色辅助书、聊天绑定书与预设关联世界书共同参与扫描',
        summary: '根据关键词、次要关键词、常驻、概率与递归规则，在提示词组装时按需注入设定。Luker 新增「世界书激活链路追踪」，记录每次扫描中条目的命中关键词、匹配位置、扫描深度、激活方式与注入位置，且支持预设关联世界书。',
        troubleshooting: [
            '条目为什么没触发或误触发：优先调 wb_read_world_info_trace 直接查看最近一次真实扫描（或干跑）的激活记录与未激活原因，再调 wb_read_world_info 核对关键词、禁用状态、常驻标志、位置与深度。',
            '找不到某本世界书：确认它绑定在全局、角色主书、角色辅书、聊天书还是当前预设的关联世界书里。',
        ],
        docPath: 'docs/zh-CN/features/world-info-trace.md',
    },
    {
        id: 'variable-op-log',
        title: '逐楼层变量与操作日志（Variable Op Log）',
        category: '变量与状态',
        keywords: ['变量', 'variable', 'setvar', 'addvar', 'incvar', 'decvar', 'pushvar', 'popvar', 'deletevar', '逐楼层变量', '烧瓶', '状态栏', 'mvu', '数值', 'swipe', '重放', '结构化变量'],
        entryPoint: '带变量操作的消息下方会出现「烧瓶」图标，点击可查看、新增、编辑或删除该楼层的变量操作',
        scope: '聊天本地变量（chatMetadata.variables）按聊天与时间线楼层/swipe 重放；全局变量跨聊天共享且不参与逐楼层提取',
        summary: 'Luker 自动从 AI 回复中提取 {{setvar::}}/{{addvar::}}/{{incvar::}}/{{decvar::}}/{{deletevar::}}/{{pushvar::}}/{{popvar::}} 等赋值宏，记录到该楼层的 extra.var_ops 并从可见正文移除；删除消息或切换 swipe 时自动按现存楼层重算变量。支持点号路径的结构化对象与 {{each}} 遍历。',
        troubleshooting: [
            '数值没更新、变回旧值或状态栏显示异常：优先调 wb_read_variables 查看当前聊天/全局变量值以及最近各楼层记录的 var_ops。',
            '注意优先级冲突：世界书或预设里的 {{setvar}} 每轮提示词组装时都会重新执行并覆盖同名变量；希望由 AI 剧情推进修改的变量，不应在世界书/Quick Reply 里重复覆盖；编辑消息正文不会重新提取赋值，需在烧瓶面板改。',
        ],
        docPath: 'docs/zh-CN/features/variable-op-log.md',
    },
    {
        id: 'regex-scope-provider',
        title: '正则脚本、作用范围与插件注册正则（Regex）',
        category: '文本处理',
        keywords: ['正则', 'regex', '吞字', '消失', '不显示', '乱码', '格式', '状态栏', '仅格式显示', '仅格式提示词', '插件正则', 'pluginlanes', '局部正则', '全局正则', '预设正则'],
        entryPoint: '扩展 → 正则（Regex）；角色局部正则与预设正则亦可在对应编辑器查看',
        scope: '分为全局正则、角色卡局部正则、预设正则，以及扩展动态注册的插件正则（支持区分主聊天与插件请求/回复通道）',
        summary: '在用户输入、AI 输出、斜杠命令、世界书、思考块或插件请求/回复上执行正则替换。支持「仅格式显示」（只改界面显示不改发给模型的原文）和「仅格式提示词」（只改发给模型的文本不改界面显示）。',
        troubleshooting: [
            'AI 明明写了内容但聊天框空白/被吞字/标签残缺：先调 wb_read_regex 检查已启用的全局、角色、预设与插件正则，再对照 wb_read_chat 原文和 wb_read_request 的原始 reply。',
            '状态栏样式或 HTML 错乱：检查是否有多条状态栏正则同时启用导致互相覆盖，或正则最小/最大深度限制过窄。',
        ],
        docPath: 'docs/zh-CN/features/regex-scope.md',
    },
    {
        id: 'presets-and-decoupling',
        title: '预设系统、预设解耦、角色绑定预设与预设世界书',
        category: '预设与提示词',
        keywords: ['预设', 'preset', '预设解耦', '提示词管理器', 'prompt', '提示词分组', '预设分组', '角色绑定预设', '绑定预设', '预设世界书', '补全预设助手', 'temperature', 'max_tokens', 'reasoning_effort'],
        entryPoint: '顶部导航栏 → AI 响应配置（预设面板）；AI 编辑入口在 工作台 → AI 迭代 → 预设',
        scope: '预设库全局共享；角色卡可携带并绑定推荐预设（含默认人设）；预设可关联世界书',
        summary: 'Luker 实现了「预设解耦」：切换 Chat Completion 预设只切提示词条目和采样参数，不再意外改动 API 连接配置。此外支持预设分组、提示词条目折叠分组、角色卡绑定推荐预设、预设关联世界书，以及工作台里的补全预设助手。',
        troubleshooting: [
            '回复风格、长度、思维链或格式不对：调 wb_read_preset 查看启用条目顺序与完整采样参数（temperature/top_p/max_tokens/reasoning_effort/show_thoughts/assistant_prefill 等），必要时调 wb_read_preset(entry=...) 读具体条目全文。',
            '切换角色后预设自动变了：检查该角色卡是否绑定了推荐预设（角色绑定预设）。',
        ],
        docPath: 'docs/zh-CN/improvements/preset-decoupling.md',
    },
    {
        id: 'connections-and-generation',
        title: 'API 连接配置、函数调用运行时与 WebSocket 代理',
        category: '连接与生成',
        keywords: ['连接', 'connection', 'api', '模型', '代理', 'proxy', 'ws', 'websocket', '流式', 'stream', '函数调用', 'function call', 'tool call', '纯文本', 'rpm', '重试', '超时', '429', '500', '断连'],
        entryPoint: '顶部导航栏 → API 连接；连接配置管理在 连接配置（Connection Manager）下拉中',
        scope: '连接配置独立于生成预设管理；支持按连接配置独立设置 RPM 限速、重试次数、流式与函数调用模式',
        summary: 'Luker 将连接配置与生成预设解耦，并内置统一生成层与函数调用运行时（支持原生 tool call 与纯文本 XML 协议自动降级，支持流式工具调用归一化），同时支持 WebSocket 持久代理降低弱网/移动端长连接中断概率。',
        troubleshooting: [
            '报 401/403/404/429/5xx 或工具调用失败：先调 wb_list_requests(only_errors=true) 与 wb_read_request 查看精确 HTTP 状态码和报错原文，再调 wb_read_luker_env(part="connections") 核对连接配置与函数调用设置。',
            '移动端锁屏或切网络导致生成中断：建议在连接/代理配置中检查 WebSocket 代理与流式设置。',
        ],
        docPath: 'docs/zh-CN/improvements/function-call-runtime.md',
    },
    {
        id: 'request-inspector-and-logs',
        title: '请求检查器、前端日志与后端日志',
        category: '诊断与日志',
        keywords: ['请求检查器', 'request inspector', '日志', '前端日志', '后端日志', '服务器日志', '调试日志', 'debug', '报错', 'error', '耗时', 'token', '中止', 'abort', 'bug 报告'],
        entryPoint: '用户设置 → 日志 / 请求检查器按钮；前端调试日志开关在 用户设置 → 日志（或在工作台问问左侧一键开启）',
        scope: '请求检查器按用户保留近期完整请求记录（默认约 200 条）；前端日志存在浏览器内存中刷新清空；后端日志在多用户模式下仅管理员可读',
        summary: '请求检查器记录每次聊天、插件、生图和向量请求的完整输入消息、工具定义、回复、思考内容、耗时、token 用量与报错，支持导出与中止运行中请求；配合前端与服务端日志构成完整排障链路。',
        troubleshooting: [
            '前端日志里看不到 API 详情：检查「前端调试日志」开关是否开启。',
            '查某次回复实际发给模型什么：优先用 wb_list_requests 找对应主模型请求 ID，再用 wb_read_request(id=..., tail_messages=...) 查看末尾实际消息与回复。',
        ],
        docPath: 'docs/zh-CN/features/logging.md',
    },
    {
        id: 'search-tools',
        title: '搜索插件（Search Tools）',
        category: '联网检索',
        keywords: ['搜索', 'search', 'search-tools', '联网', '网页', '搜索引擎', 'tavily', 'searxng', 'google', 'bing', '图片搜索', '__search_tools__'],
        entryPoint: '扩展 → 搜索插件（Search Tools）',
        scope: '搜索引擎与 API 密钥全局配置；检索产出可写入共享托管世界书 __SEARCH_TOOLS__ 或当前聊天世界书，并可提供给编排 Agent 使用',
        summary: '为角色和编排器提供联网网页搜索、页面访问、图片搜索与网页图片提取能力，支持多种搜索引擎后端与搜索 Agent 工作模式，并能将查到的事实资料结构化沉淀为受控世界书条目。',
        troubleshooting: [
            '联网搜索不生效或报错：调 wb_read_luker_env(part="search_tools") 查看开关、工作模式与已配置引擎，同时查 wb_list_requests 里归因为「联网搜索」的请求和前端日志。',
        ],
        docPath: 'docs/zh-CN/features/search-tools.md',
    },
    {
        id: 'skills',
        title: 'Skills 技能系统',
        category: '多智能体',
        keywords: ['skill', 'skills', '技能', 'skill.md', '出厂技能', '反八股', '知识包', '技能管理'],
        entryPoint: '工作台 → 编排 → 准备阶段 → 管理技能…；也可在 工作台 → AI 迭代 → 预设/编排 中由 AI 抽取或编写',
        scope: '4 级作用域：global（全局）、preset（对话预设）、orch-preset（编排方案）、character（角色卡）',
        summary: 'Skill 是以目录和 SKILL.md 组织的按需读取知识包，用于把写作规则、口吻规范、反八股清单、剧情摘要规则等模块化拆分，挂载到指定编排 Agent 后由 Agent 按需读取，避免塞爆主系统提示词。',
        troubleshooting: [
            'Agent 没遵循某条 Skill：调 wb_read_luker_env(part="skills") 核实该 Skill 是否存在及其作用域，再调 wb_read_orch(part="profile") 检查对应 Agent 是否挂载了该 Skill。',
        ],
        docPath: 'docs/zh-CN/features/skills/index.md',
    },
    {
        id: 'cardapp-and-editor',
        title: 'CardApp 与角色卡编辑助手 / CardApp Studio',
        category: '角色卡与交互',
        keywords: ['cardapp', 'studio', '角色卡编辑助手', 'cea', '状态面板', '互动面板', '小应用', '角色卡'],
        entryPoint: '工作台 → AI 迭代 → 角色卡；完整代码开发入口在 扩展 → 角色卡编辑助手 → 打开 CardApp Studio',
        scope: 'CardApp 嵌入在单张角色卡内，切到该角色时自动加载，离开时卸载，通过 Luker 状态系统与聊天变量读写数据',
        summary: 'CardApp 允许角色卡携带自定义交互界面（状态面板、背包、任务栏、小游戏等），结合逐楼层变量与命名空间状态系统驱动实时 UI；CardApp Studio 提供代码编辑、实时预览、版本历史与 AI 提案编辑。',
        troubleshooting: [
            'CardApp 面板报错或不刷新：先查 wb_read_frontend_logs(level="error") 看脚本报错，再查 wb_read_variables 核实面板依赖的聊天变量键名与值是否正确。',
        ],
        docPath: 'docs/zh-CN/features/cardapp.md',
    },
    {
        id: 'hook-order',
        title: '扩展钩子执行排序（Hook Order）',
        category: '扩展与兼容',
        keywords: ['hook', '钩子', '排序', 'hook-order', '扩展顺序', '冲突', '执行顺序', '拦截器'],
        entryPoint: '扩展 → 钩子执行排序（Hook Order）',
        scope: '全局账号设置，控制注册到同一生成事件钩子的多个扩展的执行先后顺序',
        summary: '当记忆图、编排器、搜索插件或第三方扩展同时监听消息生成前/后钩子时，可通过钩子执行排序手动调整先后次序，避免后执行的扩展读不到前者产出的结果或互相覆盖。',
        troubleshooting: [
            '多个扩展一起开时顺序错乱（例如搜索结果没进入编排或记忆）：调 wb_read_luker_env(part="extensions") 核实已启用扩展和 hook-order 配置，并检查前端日志中的执行顺序。',
        ],
        docPath: 'docs/zh-CN/features/hook-order.md',
    },
    {
        id: 'sync',
        title: '多端同步（局域网同步 / 加密 S3 同步）',
        category: '同步与备份',
        keywords: ['同步', 'sync', 's3', '局域网同步', 'lan', '冲突', 'conflict', '停滞', 'stalled', '备份', '跨设备', '恢复'],
        entryPoint: '用户设置 → 帐户 → 备份与恢复 → 同步 → 打开同步',
        scope: '按账号配置同步后端（配对局域网设备或加密 S3 存储桶），支持按类别选择同步范围、定时计划、冲突分支与撤销恢复',
        summary: '基于增量同步与完整性哈希的跨设备同步系统。S3 同步在上传前端到端加密；当多端同时修改同一聊天或文件时，会保留冲突分支或记录待处理冲突供用户选择，不静默丢数据。',
        troubleshooting: [
            '怀疑同步没生效、出现冲突聊天分支或文件停滞：调 wb_read_luker_env(part="sync") 直接查看同步后端状态、待处理冲突数与停滞文件路径，并结合 wb_read_server_logs 查看同步错误。',
        ],
        docPath: 'docs/zh-CN/improvements/sync.md',
    },
    {
        id: 'state-and-storage',
        title: '状态系统、后端实时存储与存储审查',
        category: '数据与存储',
        keywords: ['状态系统', 'state', '存储', 'storage', '配额', 'quota', '存储审查', 'sqlite', '增量同步', '丢消息', '保存失败', '并发冲突'],
        entryPoint: '用户设置 → 帐户 → 存储审查（含服务端与浏览器两部分）',
        scope: '支持全局、角色、聊天、预设、楼层多级命名空间状态；聊天变更由后端实时持久化并做完整性哈希校验',
        summary: 'Luker 将聊天与状态持久化下沉到后端并引入增量更新与哈希冲突校验，防止断网或标签页关闭丢消息；存储审查可下钻查看服务端与浏览器各模块的空间占用。',
        troubleshooting: [
            '提示保存冲突或空间不足：查 wb_read_frontend_logs 与 wb_read_server_logs 中的存储/配额报错，提醒用户到「用户设置 → 帐户 → 存储审查」清理占用。',
        ],
        docPath: 'docs/zh-CN/features/storage-inspector.md',
    },
    {
        id: 'macros',
        title: '宏引擎（Macros 2.0）',
        category: '提示词与设定',
        keywords: ['宏', 'macro', 'macros', 'getvar', 'setvar', 'each', 'pipe', '{{char}}', '{{user}}', '占位符', '模板'],
        entryPoint: '可用于预设、世界书、角色卡、聊天消息、斜杠命令与正则替换中',
        scope: '提示词组装时求值；回复正文里的赋值宏由逐楼层变量引擎提取执行',
        summary: '支持 {{char}}/{{user}}/{{getvar::}}/{{each::}} 循环遍历、条件控制流与斜杠命令管道宏 {{pipe}}。插件内部编辑类任务为保留源码模板通常不展开宏，而运行时 Agent 会以 skipSideEffects 模式展开展示宏。',
        troubleshooting: [
            '宏没有被替换而是原样发给了模型：检查宏语法拼写（双花括号与 :: 分隔符）、是否处于不展开宏的编辑场景，并通过 wb_read_request 核实发给模型的最终文本。',
        ],
        docPath: 'docs/zh-CN/basics/macros.md',
    },
    {
        id: 'chat-management',
        title: '聊天管理、合并拆分与群组聊天',
        category: '聊天管理',
        keywords: ['聊天管理', '合并聊天', '拆分聊天', '分支', 'swipe', '群聊', '群组', 'group', '过往聊天'],
        entryPoint: '聊天选项 → 过往聊天（顶部可合并聊天）；消息菜单可创建分支或拆分聊天',
        scope: '每段聊天拥有独立历史、聊天变量与聊天级世界书/记忆图数据',
        summary: '支持按楼层区间将多段聊天合并为新聊天、从任意切点拆分为多段聊天、创建分支与多 swipe 切换，以及多角色群组聊天。',
        troubleshooting: [
            '群聊中为什么工作台看不到角色卡：群聊没有单一绑定角色卡，wb_read_character 会明确提示当前在群聊中。',
        ],
        docPath: 'docs/zh-CN/features/chat-merge-split.md',
    },
    {
        id: 'tts-npc-attribution',
        title: 'TTS NPC 对白归属',
        category: '语音与交互',
        keywords: ['tts', '语音', '朗读', 'npc', '对白归属', '引号'],
        entryPoint: '扩展 → TTS（开启 NPC 对白归属并配置各 NPC 语音映射）',
        scope: '按对话动态识别引号对白归属，语音映射可持久化配置',
        summary: '开启后由后台 AI 自动判断一条消息里多句中英文引号对白分别属于哪位角色，并为每句对白提供独立声线与单独播放按钮。',
        troubleshooting: [
            '对白声音分错人或没触发：检查 TTS 扩展是否开启 NPC 归属，并查 wb_list_requests 看后台归属判定请求是否成功。',
        ],
        docPath: 'docs/zh-CN/features/tts-npc-attribution.md',
    },
    {
        id: 'user-settings-and-clients',
        title: '用户设置增强、多用户鉴权与多端客户端',
        category: '系统与部署',
        keywords: ['用户设置', '沉浸模式', '后台生成', '通知', '多用户', '鉴权', 'oauth', '公告', '桌面端', 'android', 'ios', '鸿蒙', 'harmonyos', '局域网', '远程访问', '服务端插件', 'config.yaml'],
        entryPoint: '顶部导航栏 → 用户设置；管理员面板在多用户模式下可管理账号、配额、公告与备份',
        scope: '服务端配置位于 config.yaml；用户界面与沉浸/通知等偏好按账号保存',
        summary: 'Luker 提供桌面端、Android APK、iOS 自签名包与 HarmonyOS 客户端，内置多用户账号/OAuth/配额/公告/备份、沉浸模式、后台生成通知与服务端插件支持。',
        troubleshooting: [
            '提示无权限读取服务器日志：多用户模式下服务器日志仅管理员可读。',
            '局域网或手机访问不了：检查 config.yaml 的 listen 与 whitelist 设置及反向代理/隧道配置。',
        ],
        docPath: 'docs/zh-CN/features/user-settings-additions.md',
    },
]);

/**
 * 将中英文查询串拆成适合匹配的词元（保留完整词、按空白/标点分词，同时为中文短语保留双字切片）。
 *
 * @param {string} raw
 * @returns {string[]}
 */
function tokenizeQuery(raw) {
    const clean = String(raw || '').trim().toLowerCase();
    if (!clean) return [];
    const tokens = new Set();
    const parts = clean.split(/[\s,，。！？、；;:/\\|()（）「」【】"'\-_]+/).filter(Boolean);
    for (const part of parts) {
        tokens.add(part);
        // 针对连续中文长句提取 2 字切片，提升口语化提问（如「世界书怎么没触发」）的召回率
        if (/[\u4e00-\u9fff]/.test(part) && part.length >= 3) {
            for (let i = 0; i < part.length - 1; i++) {
                tokens.add(part.slice(i, i + 2));
            }
        }
    }
    return [...tokens];
}

/**
 * 列出所有内置 Luker 文档主题的紧凑目录。
 *
 * @returns {Array<{ id: string, title: string, category: string, entryPoint: string, docPath: string }>}
 */
export function listLukerDocTopics() {
    return LUKER_DOCS.map(doc => ({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        entryPoint: doc.entryPoint,
        docPath: doc.docPath,
    }));
}

/**
 * 按关键词或分类检索内置 Luker 功能文档知识库。
 *
 * @param {{ query?: string, category?: string, limit?: number }} [opts]
 * @returns {{ mode: 'directory'|'search', totalTopics: number, matched: number, items: Array<object> }}
 */
export function searchLukerDocs({ query = '', category = '', limit = 5 } = {}) {
    const q = String(query || '').trim();
    const cat = String(category || '').trim().toLowerCase();
    const maxItems = Math.max(1, Math.min(20, Number(limit) || 5));

    const pool = cat
        ? LUKER_DOCS.filter(d => d.category.toLowerCase().includes(cat) || d.id.toLowerCase().includes(cat))
        : LUKER_DOCS;

    if (!q) {
        return {
            mode: 'directory',
            totalTopics: LUKER_DOCS.length,
            matched: pool.length,
            items: pool.map(doc => ({
                id: doc.id,
                title: doc.title,
                category: doc.category,
                entryPoint: doc.entryPoint,
                scope: doc.scope,
                docPath: doc.docPath,
            })),
        };
    }

    const qLower = q.toLowerCase();
    const tokens = tokenizeQuery(q);
    const scored = [];

    for (const doc of pool) {
        let score = 0;
        const titleLower = doc.title.toLowerCase();
        const idLower = doc.id.toLowerCase();
        const kwList = doc.keywords.map(k => k.toLowerCase());
        const bodyLower = `${doc.summary} ${doc.entryPoint} ${doc.scope} ${doc.troubleshooting.join(' ')}`.toLowerCase();

        if (idLower === qLower || titleLower.includes(qLower)) score += 30;
        if (kwList.some(k => k === qLower)) score += 25;
        else if (kwList.some(k => k.includes(qLower) || qLower.includes(k))) score += 16;
        if (bodyLower.includes(qLower)) score += 10;

        for (const tok of tokens) {
            if (tok.length < 2 && !/[\u4e00-\u9fff]/.test(tok)) continue;
            if (idLower.includes(tok)) score += 8;
            if (titleLower.includes(tok)) score += 7;
            if (kwList.some(k => k === tok)) score += 8;
            else if (kwList.some(k => k.includes(tok) || (tok.length >= 3 && tok.includes(k)))) score += 4;
            if (bodyLower.includes(tok)) score += 2;
        }

        if (score > 0) {
            scored.push({ doc, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, maxItems).map(({ doc }) => ({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        entryPoint: doc.entryPoint,
        scope: doc.scope,
        summary: doc.summary,
        troubleshooting: doc.troubleshooting,
        docPath: doc.docPath,
    }));

    return {
        mode: 'search',
        totalTopics: LUKER_DOCS.length,
        matched: scored.length,
        items: picked,
    };
}
