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
        keywords: ['工作台', 'workbench', '总览', '问问', 'ai 迭代', 'ai迭代', '改动记录', '改动清单', '撤销', '回滚', '小建议', 'alt+w', '胶囊', 'plugin-only', '未保存'],
        entryPoint: '输入框旁魔杖菜单 → 工作台；或点击右下角常驻胶囊；或按快捷键 Alt+W',
        scope: '工作台设置跟随账号（extensionSettings.workbench）；会话按当前聊天/全局隔离',
        summary: 'Luker 原生统一工作区，集成总览（最近一次提示词 token 分解与本地规则小建议）、问问（只读诊断助手）、AI 迭代（记忆图/记忆结构/编排/预设/角色卡/世界书/图像生成的对话式差异编辑）、改动记录（当前页面会话内逐条撤销）以及嵌入式记忆图、编排、图像生成面板。',
        troubleshooting: [
            '工作台 AI 配置支持「单独指定 → 插件设置 → 共用设置 → 内置示例」解析；生成预设默认优先选用 plugin-only（如已导入），否则回退当前预设。',
            '「问问」严格只读且默认自动脱敏 API 密钥与 URL；修改配置请通过回答底部的「去改 XXX」跳转到对应 AI 迭代工作台（区分「记忆图」改聊天节点与「记忆结构」改类型配置）。',
            '误应用了 AI 迭代改动：在工作台左侧「改动记录」里可按工作台筛选并在当前页面会话内逐条撤销（刷新页面前有效）。',
            '在群聊中工作台按「未选择单一角色卡」处理，角色卡专属字段与单卡绑定项不可用。',
        ],
        docPath: 'docs/zh-CN/features/workbench.md',
    },
    {
        id: 'run-panel',
        title: '共享运行面板（Run Panel）',
        category: '核心工作区',
        keywords: ['运行面板', 'run panel', 'run-panel', '悬浮窗', '自动打开', '停止运行', '轮次卡片', '轨迹导出', '状态胶囊', '重置位置'],
        entryPoint: '编排器或预请求搜索 Agent 运行时自动弹出；开关与大小位置在 工作台 → 设置 → 窗口（运行面板 / 运行面板默认大小 / 恢复默认）；也可从 扩展 → 搜索工具 → 显示搜索运行面板 打开',
        scope: '内存态共享悬浮窗，桌面端与移动端各自记忆坐标和默认大小，供编排器、预请求搜索 Agent 等多步任务共用',
        summary: '集中展示多步 AI 任务（编排器、预请求搜索 Agent 等）的实时轮次卡片、流式思考与工具调用、token 用量与停止按钮；支持一键导出 JSON 轨迹或跳转工作台查看详情/AI 诊断，空闲或收起时折叠为可拖动的状态胶囊。',
        troubleshooting: [
            '不希望每次运行都自动弹出：到「工作台 → 设置 → 窗口」关闭「运行面板 → 运行时自动打开」（或在运行面板菜单里切换）。',
            '悬浮窗拖偏或挡住屏幕：在「工作台 → 设置 → 窗口」点「恢复默认」可同时重置工作台与运行面板在双端的默认位置。',
        ],
        docPath: 'docs/zh-CN/development/extension-api/run-panel.md',
    },
    {
        id: 'memory-graph',
        title: '记忆图（Memory Graph）',
        category: '长期记忆',
        keywords: ['记忆图', 'memory-graph', 'memory', '记忆', '记住', '记不住', '忘事', '忘记', '想不起来', '常驻注入', 'core', 'focus', '召回', '压缩', '合并', '回溯', 'schema', '记忆结构', '节点', '向量', 'rag', '嵌入', 'embedding', '重排', 'rerank'],
        entryPoint: '工作台 → 记忆图（含图谱/时间线/数据表/记忆结构/设置），或 扩展 → 记忆',
        scope: '记忆节点数据按聊天独立；记忆结构（Schema）与高级设置支持「全局」或「当前角色单独覆盖」两种作用域',
        summary: '后台自动从对话提取带类型的结构化记忆节点与关系，并在生成前分成两路注入提示词：core（常驻注入，受回溯楼层上限与自动压缩控制）与 focus（按需召回，支持 LLM 召回或 RAG 向量检索与可选重排）。修改节点走「AI 迭代 → 记忆图」，修改类型与提取规则走「AI 迭代 → 记忆结构」。',
        troubleshooting: [
            '角色「记不住 / 突然忘了某件事」排查顺序：先用 wb_read_memory(part="search", query=...) 查图谱里有没有该节点 → 若无，检查自动提取是否开启、提取间隔（updateEvery）及最近请求是否报错；若有，看它是否被归档、是否超出常驻回溯楼层上限（persistentInjectionMaxSeqDistance）且未被本次 focus 召回。',
            '开启 RAG 向量召回步骤：先在顶栏「API 连接」面板的「嵌入」（以及可选「重排」）选项卡创建配置并测试连接，再回到「记忆图 → 设置」选中该配置、构建向量索引并切换到 RAG 召回。',
            '常驻注入 token 暴涨排查：查 wb_read_memory(part="summary") 看 unmerged 未合并事件数、自动层次压缩是否开启，以及 maxSeqDistance 是否为 0（不限回溯）；排查高占用条目调 wb_read_memory(part="core") 或 "focus"。',
        ],
        docPath: 'docs/zh-CN/features/memory-graph.md',
    },
    {
        id: 'orchestrator',
        title: '多 Agent 编排（Orchestrator）',
        category: '多智能体',
        keywords: ['编排', 'orchestrator', 'orch', 'spec', '流水线', 'single', '单助手', 'agenda', '调度', 'loop', '循环', 'director', '导演', '胶囊', 'capsule', '笔记', 'notes', '自定义工具'],
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
        entryPoint: '工作台 → 图像生成（画室 / 角色库 / 运行轨迹），或 扩展 → 图像生成，或 魔杖菜单 → 画室 / 为最后一条消息生成插图',
        scope: '生图后端与预设为全局设置；角色库档案全局共享；运行轨迹记录近期正文插图与探索运行',
        summary: '统一本地与云端生图后端（ComfyUI、WebUI、云端多供应商等）、跨后端角色与画风参考图协议、双 Agent 协作的 AI 正文插图、全局角色库档案，以及支持自由画图与角色定妆的交互式画室。',
        troubleshooting: [
            '生图或 AI 插图失败：调 wb_read_sd(part="summary") 与 wb_read_sd(part="last_run")，优先检查绑定的连接配置是否已被删除（brokenConnectionProfile）、后端能力（capabilities）与 ComfyUI 节点/占位符配置（workflows），也可用 wb_read_request 查看 type="image" 的生图请求记录。',
            '生图人物走形或服装不对：调 wb_read_sd(part="characters") 和 wb_read_sd(part="presets") 检查角色库标签、默认服装和插图提示词预设。',
        ],
        docPath: 'docs/zh-CN/features/image-generation.md',
    },
    {
        id: 'world-info-and-trace',
        title: '世界书与世界书激活链路追踪（World Info & Trace）',
        category: '提示词与设定',
        keywords: ['世界书', 'lorebook', 'world info', 'world-info', 'wi', '激活', '触发', '没触发', '未激活', '追踪', 'trace', '扫描深度', '常驻', '关键词', '预设世界书', '辅书'],
        entryPoint: '顶部导航栏 → 世界书；每个条目右上角路线图标可打开「激活链路追踪」弹窗',
        scope: '支持全局世界书、角色主书、角色辅助书、聊天绑定书与预设关联世界书共同参与扫描',
        summary: '根据关键词、次要关键词、常驻、概率与递归规则，在提示词组装时按需注入设定。Luker 新增「世界书激活链路追踪」，记录每次扫描中条目的命中关键词、匹配位置、扫描深度、激活方式与注入位置，且支持预设关联世界书。',
        troubleshooting: [
            '条目为什么没触发或误触发：优先调 wb_read_world_info_trace 直接查看最近一次真实扫描（或干跑）的激活记录与未激活原因，再调 wb_read_world_info 核对关键词、禁用状态、常驻标志、位置与深度。',
            '找不到某本世界书：确认它绑定在全局、角色主书、角色辅书、聊天书还是当前预设的关联世界书（preset_lorebook）里。',
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
        keywords: ['正则', 'regex', '吞字', '消失', '不显示', '乱码', '格式', '状态栏', '仅格式显示', '仅格式提示词', '插件正则', 'pluginlanes', '局部正则', '全局正则', '预设正则', '授权'],
        entryPoint: '扩展 → 正则（Regex）；角色局部正则与预设正则亦可在对应编辑器查看',
        scope: '分为全局正则、角色卡局部正则、预设正则，以及扩展动态注册的插件正则（支持区分主聊天与插件请求/回复通道）',
        summary: '在用户输入、AI 输出、斜杠命令、世界书、思考块或插件请求/回复上执行正则替换。支持「仅格式显示」（只改界面显示不改发给模型的原文）和「仅格式提示词」（只改发给模型的文本不改界面显示）；角色局部正则与预设正则需用户授权允许才会执行。',
        troubleshooting: [
            'AI 明明写了内容但聊天框空白/被吞字/标签残缺：先调 wb_read_regex 检查已启用的全局、角色、预设与插件正则（含 owner 与 pluginLanes），再对照 wb_read_chat 原文和 wb_read_request 的原始 reply。',
            '角色卡或预设自带正则没生效：在 wb_read_regex 返回里检查该脚本的 allowed 字段是否为 true（未授权的角色/预设正则即使未禁用也不会运行）。',
            '状态栏样式或 HTML 错乱：检查是否有多条状态栏正则同时启用导致互相覆盖，或正则最小/最大深度限制过窄。',
        ],
        docPath: 'docs/zh-CN/features/regex-scope.md',
    },
    {
        id: 'presets-and-decoupling',
        title: '预设系统、预设解耦、角色绑定预设与预设世界书',
        category: '预设与提示词',
        keywords: ['预设', 'preset', '预设解耦', '提示词管理器', 'prompt', '提示词分组', '预设分组', '角色绑定预设', '绑定预设', '预设世界书', '流式', 'stream', 'temperature', 'max_tokens', 'reasoning_effort'],
        entryPoint: '顶部导航栏 → AI 响应配置（预设面板）；AI 编辑入口在 工作台 → AI 迭代 → 预设',
        scope: '预设库全局共享；角色卡可携带并绑定推荐预设（origin="character"）；预设可关联内嵌世界书（extensions.preset_lorebook）；流式输出开关属于生成预设',
        summary: 'Luker 实现了「预设解耦」：切换 Chat Completion 预设只切提示词条目和采样/流式参数，不再意外改动 API 连接配置。此外支持预设分组、提示词条目折叠分组、角色卡绑定推荐预设与人设，以及预设关联世界书。',
        troubleshooting: [
            '回复风格、长度、流式输出、思维链或格式不对：调 wb_read_preset 查看启用条目顺序、预设来源（origin）与完整采样参数（temperature/top_p/max_tokens/stream/reasoning_effort/show_thoughts/assistant_prefill 等），必要时调 wb_read_preset(entry=...) 读具体条目全文。',
            '切换角色后预设自动变了：调 wb_read_preset 检查 origin 是否为 character（角色卡绑定内嵌预设）。',
        ],
        docPath: 'docs/zh-CN/improvements/preset-decoupling.md',
    },
    {
        id: 'preset-assistant',
        title: '补全预设助手（CPA / 编排器适配 / 仅保留破限）',
        category: '预设与提示词',
        keywords: ['补全预设助手', '预设助手', 'cpa', '通用编辑', '编排器适配', '仅保留破限', '破限', '-orchestrator', '-jailbreak', '派生预设', '派生', '抽取 skill', '打包 skill', '参考预设'],
        entryPoint: '聊天补全预设工具栏魔杖图标；或 工作台 → AI 迭代 → 预设；或 扩展 → 聊天补全预设助手 → 在工作台中打开（同面板提供新建预设与将 Skills 打包到此预设）',
        scope: '编辑当前选中的对话补全预设；编排器适配与仅保留破限模式默认派生新预设（-orchestrator / -jailbreak），原预设保持不动',
        summary: '在工作台通过对话修改预设参数与提示词条目、对比参考预设，并提供 3 种编辑模式：1）通用编辑（直接按需求改动）；2）编排器适配（改写干扰工具调用的强格式约束、禁用编排已注入占位符，并自动将共用写作规则抽取为 Skill，默认派生 -orchestrator 预设）；3）仅保留破限（保留越狱指令、禁用 RP 叙事/文风条目，默认派生 -jailbreak 预设供记忆图、工作台等工具型任务使用）。',
        troubleshooting: [
            '工具型插件（记忆图整理/问问/工作台）总爱跑偏角色扮演或拒答：可在「工作台 → 设置」点「从现有预设派生」或在「AI 迭代 → 预设」切换「仅保留破限」模式派生 -jailbreak 预设，或导入内置 plugin-only 示例。',
            '想把编排器适配后的预设连同抽取的 Skills 一起导出分享：先派生 -orchestrator 预设，再到「扩展 → 聊天补全预设助手 → 将 Skills 打包到此预设」打包进预设文件。',
        ],
        docPath: 'docs/zh-CN/features/preset-assistant.md',
    },
    {
        id: 'connections-and-generation',
        title: 'API 连接配置、Embedding/Rerank、函数调用运行时与 WebSocket 代理',
        category: '连接与生成',
        keywords: ['连接', 'connection', 'api', '模型', '代理', 'proxy', '网络代理', 'ws', 'websocket', '函数调用', 'function call', 'tool call', '纯文本', 'rpm', '重试', '超时', '429', '500', '断连', 'embedding', '嵌入', 'rerank', '重排', '向量'],
        entryPoint: '顶部导航栏 → API 连接（聊天补全连接配置在 连接配置 下拉中；嵌入与重排在 API 连接面板的「嵌入」「重排」选项卡）',
        scope: '连接配置独立于生成预设管理，按连接配置保存 API/模型/网络代理/RPM 限速/请求超时/重试次数/纯文本函数调用开关；流式开关位于生成预设；WebSocket 代理对用户透明无需配置',
        summary: 'Luker 将 API 连接配置与生成预设解耦，在 API 连接抽屉统一管理聊天补全、嵌入（Embedding）与重排（Rerank）配置，内置统一生成层与函数调用运行时（支持原生 tool call 与纯文本 XML 协议自动降级），并自动启用透明的 WebSocket 持久代理（心跳保活、断线自动重连与断点续传，无需额外配置）。',
        troubleshooting: [
            '报 401/403/404/429/5xx 或工具调用失败：先调 wb_list_requests(only_errors=true) 与 wb_read_request 查看精确 HTTP 状态码和报错原文，再调 wb_read_luker_env(part="connections") 核对连接配置、plainTextFunctionCalling、rpmLimit、requestTimeout 与 maxRetries。',
            '移动端锁屏或切到后台导致生成中断：WebSocket 代理默认透明生效无需配置；请在「用户设置 → UI主题 → 移动端后台保活」开启保活（手机浏览器可选「画中画」或「音频」，Android/鸿蒙应用由原生层维持），流式开关请在生成预设中核对。',
            '配置或排查 Embedding / Rerank（供记忆图 RAG 召回与向量存储使用）：在顶栏「API 连接」切换到「嵌入」或「重排」选项卡创建配置、拉取模型并测试连接，报错可在请求检查器中查看 type="embedding" 的请求记录。',
        ],
        docPath: 'docs/zh-CN/improvements/function-call-runtime.md',
    },
    {
        id: 'request-inspector-and-logs',
        title: '请求检查器、前端日志与后端日志',
        category: '诊断与日志',
        keywords: ['请求检查器', 'request inspector', '日志', '前端日志', '后端日志', '服务器日志', '调试日志', '诊断', '导出调试日志', 'debug', '报错', 'error', '耗时', 'token', '中止', 'abort', 'bug 报告'],
        entryPoint: '顶行「用户设置 → 日志 / 请求检查器」；「前端调试日志」开关与「导出调试日志」位于「用户设置 → 诊断 → 前端调试日志」（亦可在工作台问问左侧栏一键开启）',
        scope: '请求检查器按用户保留近期完整请求记录（默认约 200 条，涵盖聊天/生图/嵌入重排）；前端日志存在浏览器内存中刷新清空；后端日志在多用户模式下仅管理员可读',
        summary: '请求检查器记录每次聊天、插件、图像生成和向量嵌入/重排请求的完整输入消息、工具定义、回复、思考内容、耗时、token 用量与报错，支持导出与中止运行中请求；配合「用户设置 → 诊断 → 导出调试日志」与前后端日志构成完整排障链路。',
        troubleshooting: [
            '前端日志里看不到详细调试输出：到「用户设置 → 诊断 → 前端调试日志」开启（或在工作台问问左侧点「帮我打开」）。',
            '查某次回复实际发给模型什么：优先用 wb_list_requests 找对应主模型请求 ID，再用 wb_read_request(id=..., tail_messages=...) 查看末尾实际消息、reply、replyToolCalls 与可选 reasoning/tools。',
        ],
        docPath: 'docs/zh-CN/features/logging.md',
    },
    {
        id: 'search-tools',
        title: '搜索工具（Search Tools）',
        category: '联网检索',
        keywords: ['搜索', '搜索工具', '搜索插件', 'search', 'search-tools', '联网', '网页', '搜索引擎', 'tavily', 'searxng', 'google', 'bing', 'ddg', 'duckduckgo', '图片搜索', '__search_tools__'],
        entryPoint: '扩展 → 搜索工具',
        scope: '搜索引擎与 API 密钥全局配置；支持「暴露工具给主模型」（工具模式）与「请求前运行搜索 Agent」（预请求 Agent 模式）两个独立开关，检索结果可写入托管世界书并供其他插件调用',
        summary: '为角色和编排器提供联网网页搜索、页面访问、图片搜索与网页图片提取能力，支持 DuckDuckGo/SearXNG/Brave/Tavily/Exa/Serper/SerpApi/Z.AI/DeepSeek 等引擎；预请求搜索 Agent 运行过程实时流式展示在共享运行面板中，并将资料沉淀为受控世界书条目。',
        troubleshooting: [
            '联网搜索不生效或报错：调 wb_read_luker_env(part="search_tools") 核实 enabled（工具模式）与 preRequestEnabled（预请求 Agent 模式）开关、provider 引擎及世界书注入位置/深度，同时查 wb_list_requests 里归因为「联网搜索」的请求和前端日志。',
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
        summary: '当记忆图、编排器、搜索工具或第三方扩展同时监听消息生成前/后钩子时，可通过钩子执行排序手动调整先后次序，避免后执行的扩展读不到前者产出的结果或互相覆盖。',
        troubleshooting: [
            '多个扩展一起开时顺序错乱（例如搜索结果没进入编排或记忆）：调 wb_read_luker_env(part="extensions") 核实已启用扩展和 hook-order 配置，并检查前端日志中的执行顺序。',
        ],
        docPath: 'docs/zh-CN/features/hook-order.md',
    },
    {
        id: 'sync',
        title: '多端同步、备份恢复与局域网迁移',
        category: '同步与备份',
        keywords: ['同步', 'sync', 's3', '局域网同步', 'lan', '冲突', 'conflict', '停滞', 'stalled', '备份', '恢复', '备份与恢复', '局域网迁移', '迁移', 'zip', '增量更新', '覆盖更新', '跨设备', '撤销'],
        entryPoint: '用户设置 → 帐户 → 备份与恢复（ZIP 备份恢复 / 局域网迁移 / 同步 → 打开同步）',
        scope: '按账号管理目录级 ZIP 备份恢复、一次性局域网迁移链接，以及长期多端同步后端（局域网配对或端到端加密 S3）',
        summary: '提供三套跨设备与防丢方案：1）备份与恢复：按数据类别勾选导出/恢复 ZIP，支持「增量更新」和「覆盖更新」两种恢复模式（跨存储引擎支持临时数据库中转）；2）局域网迁移：一次性换机，旧设备生成短时一次性迁移链接，新设备粘贴导入；3）多端同步：基于增量同步与完整性哈希，支持局域网配对与端到端加密 S3，多端冲突保留分支并支持撤销。',
        troubleshooting: [
            '怀疑同步没生效、出现冲突聊天分支或文件停滞：调 wb_read_luker_env(part="sync") 直接查看各同步后端状态（kind/label/running/lastError/pendingError/stalledCount）、待处理冲突数与顶层 errors，并结合 wb_read_server_logs 查看同步错误。',
            '一次性换新设备建议用「用户设置 → 帐户 → 局域网迁移」或导出 ZIP 备份；长期多设备共用建议配置局域网同步或加密 S3 同步。',
        ],
        docPath: 'docs/zh-CN/improvements/sync.md',
    },
    {
        id: 'state-and-storage',
        title: '状态系统、后端实时存储与存储审查',
        category: '数据与存储',
        keywords: ['状态系统', 'state', '存储', 'storage', '配额', 'quota', '存储审查', '浏览器存储', 'sqlite', '增量同步', '丢消息', '保存失败', '并发冲突'],
        entryPoint: '用户设置 → 帐户 → 存储审查 / 浏览器存储',
        scope: '支持全局、角色、聊天、预设、楼层多级命名空间状态；聊天变更由后端实时持久化并做完整性哈希校验',
        summary: 'Luker 将聊天与状态持久化下沉到后端并引入增量更新与哈希冲突校验，防止断网或标签页关闭丢消息；存储审查可按类别下钻查看服务端空间与配额，浏览器存储可清理 localStorage/IndexedDB/Cache。',
        troubleshooting: [
            '提示保存冲突或空间不足：查 wb_read_frontend_logs 与 wb_read_server_logs 中的存储/配额报错，提醒用户到「用户设置 → 帐户 → 存储审查」查看服务端占用或「浏览器存储」清理本地缓存。',
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
        keywords: ['tts', '语音', '朗读', 'npc', '对白归属', '引号', '静音', '没声音', '没有声音', '管理语音', '声线', '语音映射'],
        entryPoint: '扩展 → TTS（勾选「NPC 对白归属」，在 语音映射 → 管理语音 中为说话人与 NPC 分配声线）',
        scope: '按对话动态识别引号对白归属，语音映射跨聊天持久化配置',
        summary: '开启后由后台 AI 自动判断一条消息里多句中英文引号对白分别属于哪位角色，并为每句对白提供独立声线与单独播放按钮（桌面端显示，移动端为防误触默认隐藏）。',
        troubleshooting: [
            'NPC 播放时没声音/静音：到「扩展 → TTS → 语音映射 → 管理语音」检查该 NPC 行与默认语音行——自动发现的 NPC 默认跟随默认语音，而出厂默认语音是 disabled，必须分配有效声线才会有声；也可提前在「管理语音」手动添加 NPC 名字免去首次等待。',
            '手机/移动端看不到引号旁单句小喇叭按钮：移动端默认隐藏单句播放按钮防滚动误触，属设计行为；桌面端旧消息未出现按钮时可刷新页面或切聊天再切回。',
            '对白声音分错人或没触发：确认 TTS 服务商已启用且勾选「NPC 对白归属」，并查 wb_list_requests 看后台归属判定请求是否成功。',
        ],
        docPath: 'docs/zh-CN/features/tts-npc-attribution.md',
    },
    {
        id: 'user-settings-and-clients',
        title: '用户设置增强、移动端后台保活、多用户鉴权与多端客户端',
        category: '系统与部署',
        keywords: ['用户设置', '沉浸模式', '后台保活', '移动端后台保活', '画中画', '音频保活', '锁屏', '后台生成', '通知', '回复完成通知', '诊断', '多用户', '鉴权', 'oauth', '公告', '桌面端', 'android', 'ios', '鸿蒙', 'harmonyos', '局域网', '远程访问', '服务端插件', 'config.yaml'],
        entryPoint: '顶部导航栏 → 用户设置（含 诊断 / UI主题 → 移动端后台保活 / 杂项 → 回复完成通知 / 帐户 → 备份与恢复・局域网迁移・存储审查）',
        scope: '服务端配置位于 config.yaml；用户界面、后台保活与通知等偏好按账号保存',
        summary: 'Luker 提供桌面端、Android、iOS 与鸿蒙客户端，并在用户设置中新增「诊断」菜单、沉浸模式、「UI主题 → 移动端后台保活」（手机浏览器可选画中画悬浮窗或无声音频会话，Android/鸿蒙原生保活）、后台回复完成通知，以及多用户账号/OAuth/配额/公告与服务端插件支持。',
        troubleshooting: [
            '手机切到后台或锁屏后生成断开：到「用户设置 → UI主题 → 移动端后台保活」开启（浏览器端可选「画中画」不打断音乐，或「音频」模式；桌面端隐藏此项）。',
            '提示无权限读取服务器日志：多用户模式下服务器日志仅管理员可读。',
            '局域网或手机访问不了：检查 config.yaml 的 listen 与 whitelist 设置及反向代理/隧道配置。',
        ],
        docPath: 'docs/zh-CN/features/user-settings-additions.md',
    },
]);

/** 常见中文口语泛问与通用停用词，避免双字切片污染召回排序。 */
const ZH_STOPWORDS = new Set([
    '怎么', '什么', '在哪', '哪里', '设置', '开启', '打开', '关闭', '使用', '保留',
    '为什么', '怎么用', '怎么开', '如何', '是否', '没有', '不能', '可以', '请问',
    '一下', '这个', '那个', '在哪开', '在哪里', '怎么看', '怎么改', '怎么调',
    '不会', '无法', '以前', '事情', '的事', '是什么', '什么意', '意思', '干嘛',
]);

/** 高频泛词在全库普遍出现，降权以免压过具体功能词。 */
const LOW_WEIGHT_TOKENS = new Set(['ai', 'luker', 'llm', 'api', '设置', '配置', '功能', '插件', '扩展', '模式', '面板']);

const SHORT_ASCII_RE = /^[a-z0-9]+$/i;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 判断候选文本是否命中词元：
 * 长度 <= 4 的纯 ASCII 词（如 wi / lan / rag / cpa / sd / tts）启用词边界匹配，
 * 避免 wi 误中 swipe、lan 误中 pluginlanes、rag 误中 storage。
 */
function textContainsToken(text, tok) {
    if (!text || !tok) return false;
    if (tok.length <= 4 && SHORT_ASCII_RE.test(tok)) {
        return new RegExp(`(?<![a-z0-9])${escapeRegExp(tok)}(?![a-z0-9])`, 'i').test(text);
    }
    return text.includes(tok);
}

/**
 * 将中英文查询串拆成适合匹配的词元：
 * 1. 按空白、标点及中英文边界拆分；
 * 2. 对中文短语提取 2 字与 3 字切片提升口语提问召回率；
 * 3. 过滤常见中文泛问停用词（若全部被过滤则回退保留原词）。
 *
 * @param {string} raw
 * @returns {string[]}
 */
function tokenizeQuery(raw) {
    const clean = String(raw || '').trim().toLowerCase();
    if (!clean) return [];
    const rawTokens = new Set();
    const parts = clean.split(/[\s,，。！？、；;:/\\|()（）「」【】"'_]+/).filter(Boolean);
    for (const part of parts) {
        rawTokens.add(part);
        const segments = part.match(/[a-z0-9-]+|[\u4e00-\u9fff]+/g) || [];
        for (const seg of segments) {
            rawTokens.add(seg);
            if (/^[a-z0-9-]+$/.test(seg) && seg.includes('-')) {
                for (const sub of seg.split('-').filter(Boolean)) rawTokens.add(sub);
            }
            if (/^[\u4e00-\u9fff]+$/.test(seg) && seg.length >= 3) {
                for (let i = 0; i < seg.length - 1; i++) {
                    rawTokens.add(seg.slice(i, i + 2));
                }
                for (let i = 0; i < seg.length - 2; i++) {
                    rawTokens.add(seg.slice(i, i + 3));
                }
            }
        }
    }
    const list = [...rawTokens];
    const filtered = list.filter(tok => !ZH_STOPWORDS.has(tok));
    return filtered.length ? filtered : list;
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

        const qWeight = LOW_WEIGHT_TOKENS.has(qLower) ? 0.2 : 1;
        if (idLower === qLower || textContainsToken(titleLower, qLower)) score += 30 * qWeight;
        if (kwList.some(k => k === qLower)) score += 25 * qWeight;
        else if (kwList.some(k => textContainsToken(k, qLower) || (qLower.length >= 3 && textContainsToken(qLower, k)))) score += 16 * qWeight;
        if (textContainsToken(bodyLower, qLower)) score += 10 * qWeight;

        for (const tok of tokens) {
            if (tok.length < 2 && !/[\u4e00-\u9fff]/.test(tok)) continue;
            const w = LOW_WEIGHT_TOKENS.has(tok) ? 0.2 : 1;
            if (textContainsToken(idLower, tok)) score += 8 * w;
            if (textContainsToken(titleLower, tok)) score += 7 * w;
            if (kwList.some(k => k === tok)) score += 10 * w;
            else if (kwList.some(k => textContainsToken(k, tok) || (tok.length >= 3 && textContainsToken(tok, k)))) score += 4 * w;
            if (textContainsToken(bodyLower, tok)) score += 2 * w;
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
