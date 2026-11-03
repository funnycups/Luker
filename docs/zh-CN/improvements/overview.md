# 改进总览

Luker 在 SillyTavern 的基础上改造了数据保存、预设组织、生成请求处理和扩展能力。本页说明这些改动解决了什么问题，以及它们给日常使用带来什么变化。具体配置步骤在各自页面中。

## 改进一览

| 分类 | 改进 | 解决的问题 |
| --- | --- | --- |
| 架构 | [预设解耦](/zh-CN/improvements/preset-decoupling) | 切换预设不再连带更换 API 连接 |
| 架构 | [增量同步](/zh-CN/improvements/incremental-sync) | 保存时只传输变化，减少流量与并发冲突 |
| 架构 | [后端实时存储](/zh-CN/improvements/backend-storage) | 操作后立即落盘，浏览器崩溃不丢数据 |
| 功能 | [函数调用运行时](/zh-CN/improvements/function-call-runtime) | 原生与纯文本模型都能调用工具 |
| 功能 | [角色卡绑定预设与人设](/zh-CN/improvements/card-bound-presets) | 角色卡携带作者推荐的生成配置 |
| 功能 | [请求检查器](/zh-CN/improvements/request-inspector) | 查看每次请求的输入、输出与 Token 用量 |
| 功能 | [预设关联世界书](/zh-CN/improvements/preset-world-info) | 切换预设时自动激活对应世界书 |
| 功能 | [Skills](/zh-CN/features/skills/) | 把长提示词拆成按需读取的知识包 |
| 基础设施 | [统一生成层](/zh-CN/improvements/generation-layer) | 不同后端共享同一套请求处理 |
| 基础设施 | [性能优化](/zh-CN/improvements/performance) | 更快的启动、加载与日常操作 |
| 基础设施 | [WebSocket 代理](/zh-CN/improvements/ws-proxy) | 不稳定网络中保持生成不中断 |
| 基础设施 | [认证与配额](/zh-CN/improvements/auth-and-quota) | 多人共享实例时的登录与容量管理 |
| 基础设施 | [其他改进](/zh-CN/improvements/other) | 连接管理、分组、动态模型列表等 |

记忆图、多 Agent 编排、角色卡编辑助手、搜索插件和 CardApp 属于 Luker 的独有功能，见 [独有功能](/zh-CN/features/memory-graph)。

## 架构改进

### 预设解耦

SillyTavern 把 API 连接参数和生成预设放在同一个配置对象里。切换模型或服务商时，采样参数和提示词设置会跟着改变；调整采样参数也可能意外影响连接。

Luker 把两者拆开：**连接配置**负责连到哪里，**预设**负责怎么生成。同一套预设可以搭配不同连接，同一个连接也可以搭配不同预设。角色卡绑定预设、API 连接配置等功能都建立在这个拆分之上。

详见[预设解耦](/zh-CN/improvements/preset-decoupling)。

### 增量同步

传统保存会把完整对象发送到服务端。聊天越长，每次保存传输的数据越多，并发写入也越容易互相覆盖。

Luker 只发送发生变化的部分：新消息追加、单条消息修补、元数据合并。服务端在写入后校验数据完整性，发现并发修改时拒绝覆盖。设置保存同样采用增量方式，并带冲突检测。

详见[增量同步](/zh-CN/improvements/incremental-sync)。

### 后端实时存储

SillyTavern 的部分数据要等前端触发才保存，这之间存在「已经操作但还没落盘」的窗口。进程异常退出时，这段时间的修改会丢失。

Luker 把保存职责移到服务端：数据到达即持久化，前端不再决定什么时候保存。聊天写入按顺序执行，群聊等并发场景不会互相破坏；生成完成后会确认结果已经记录。还可以配置聊天文件的自动备份。

详见[后端实时存储](/zh-CN/improvements/backend-storage)。

## 功能增强

### 函数调用运行时

不同模型对工具调用的支持不一致。有的原生支持结构化调用，有的只能在文本里写出调用意图。

Luker 提供统一的函数调用运行时：原生支持时使用模型自带的能力，不支持时用提示词引导并在本地解析。两种方式对插件和用户呈现相同的工具，连接配置中可以单独调整纯文本模式的开关与重试。

详见[函数调用运行时](/zh-CN/improvements/function-call-runtime)。

### 角色卡绑定预设与人设

角色卡作者最清楚角色在什么参数下表现最好。Luker 允许角色卡携带推荐预设和默认人设；加载角色时自动应用，离开时恢复之前的配置。绑定预设会在选择器中标记，并随角色卡导出。

详见[角色卡绑定预设与人设](/zh-CN/improvements/card-bound-presets)。

### 请求检查器

想知道一次生成到底发送了什么、消耗了多少 Token，可以打开请求检查器。它记录请求的输入、输出、耗时和 Token 用量，覆盖流式回复、图像生成、向量嵌入和重排。Token 统计与存储配额彼此独立。

详见[请求检查器](/zh-CN/improvements/request-inspector)。

### Skills

编排器里的系统提示词会随着规则增多而膨胀。Skills 把可复用的写作规则、评审方法和工作流拆成独立知识包，Agent 需要时按名称读取。

Skill 可以随角色卡或预设一起分发，接收方不需要单独安装。Director 的默认配置已经使用该机制。概念见 [Skills 概览](/zh-CN/features/skills/)，写法见[创作 Skill](/zh-CN/features/skills/authoring)。

## 基础设施

### 统一生成层

不同 AI 后端的请求路径原本各自实现，功能支持不一致。统一生成层把请求处理收敛到一处，让所有后端共享 Token 计量、流式处理、错误处理和生成确认。无论使用哪家服务，请求检查器和用量统计的行为一致。

详见[统一生成层](/zh-CN/improvements/generation-layer)。

### 认证与配额

多人共享实例时，管理员可以开启 GitHub 或 Discord 登录，为不同用户设置存储配额，并通过日志查看服务端活动。OAuth 在管理员面板中配置，不需要手写配置文件。

详见[认证与配额](/zh-CN/improvements/auth-and-quota)。

### 其他改进

API 连接配置、WebSocket 代理、HTTP 代理、预设与提示词分组、撤销提示、动态模型列表、扩展钩子排序、角色与预设状态、启动性能等改动，汇总在[其他改进](/zh-CN/improvements/other)。
