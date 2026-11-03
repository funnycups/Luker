# 宏

宏（Macro）是写成 <code v-pre>{{name}}</code> 形式的占位符，在提示词组装时替换为动态内容。预设、世界书、角色卡、聊天消息、斜杠命令与正则替换中凡进入提示词的文本字段均可使用宏。请求到达模型时，所有宏都已替换为最终字符串。

## Macros 2.0 / 实验性宏引擎

本页描述的特性由 SillyTavern 引入的 **Macros 2.0** 宏引擎提供。该引擎默认启用，可在**用户设置 → 聊天/消息处理 → 实验性宏引擎**中切换。

关闭实验性引擎后，宏仍可使用，下列特性退回到旧的正则解析流程：

| 特性 | 需要实验性引擎 |
|---|---|
| <code v-pre>{{if}}</code> / <code v-pre>{{else}}</code> / <code v-pre>{{each}}</code> 控制流 | ✓ |
| 范围宏，如 <code v-pre>{{setvar::k}}body{{/setvar}}</code> | ✓ |
| 变量简写（<code v-pre>{{.var}}</code>、<code v-pre>{{$var}}</code>、表达式） | ✓ |
| 标志位（`#`、`/`、……） | ✓ |
| 宏参数内嵌套宏 | ✓ |
| 范围宏内容保留前导空白 | ✓ |
| 多遍展开时的稳定替换顺序（从左到右、内层先于外层） | ✓ |
| 一般 <code v-pre>{{user}}</code>、<code v-pre>{{setvar::name::value}}</code>、<code v-pre>{{time}}</code>…… | 两种均能用 |

本页里某个特性看起来不生效，先检查这个开关。

## 语法

宏的形态是 <code v-pre>{{name}}</code>、<code v-pre>{{name::arg}}</code>，或 <code v-pre>{{name::arg1::arg2}}</code>。宏名**大小写不敏感**——<code v-pre>{{user}}</code>、<code v-pre>{{User}}</code>、<code v-pre>{{USER}}</code> 解析到同一个宏。花括号和宏名之间允许空白：<code v-pre>{{ user }}</code> 等价于 <code v-pre>{{user}}</code>。

宏识别子必须符合 `^[a-zA-Z][\w-_]*$`——字母开头，后接字母、数字、底线或连字号。唯一的例外是注解宏 <code v-pre>{{//}}</code>。

### 参数

参数之间用 `::` 分隔：

```text
{{setvar::hp::50}}
{{datetimeformat::YYYY-MM-DD HH:mm:ss}}
{{roll::3d6+4}}
```

单个 `:` 也可识别（<code v-pre>{{roll: 1d20}}</code>），但因为正文中经常出现单冒号，**推荐使用 `::`**。

逗号列表宏（<code v-pre>{{random}}</code>、<code v-pre>{{pick}}</code>）两种写法均可：

```text
{{random::red::green::blue}}
{{random::red,green,blue}}
```

列表项里要写字面意义的逗号，转义为 `\,`。

### 嵌套宏

宏可以嵌套。内层先解析，结果作为外层的参数：

```text
{{setvar::greeting::Hello, {{user}}!}}
{{if {{getvar::showHeader}}}}# Header{{/if}}
{{each::{{getvar::roster}}}}- {{loop_value::name}}{{/each}}
```

嵌套深度没有硬上限，但嵌套太深通常是宏在做太多事——拆成中间变量。

### 范围宏

部分宏（<code v-pre>{{if}}</code>、<code v-pre>{{each}}</code>、<code v-pre>{{trim}}</code>、<code v-pre>{{//}}</code>，以及大多数接受参数的自定义宏）支持「开 / 闭标签 + 中间内容」的写法。中间的内容会作为**最后一个位置参数**传给宏：

```text
{{if .ready}}
角色已就绪。
{{/if}}

{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

预设情况下，范围宏的内容会被**自动整理**——首尾空白被剥掉，首个非空行的共同前导缩进会从所有行里减掉。要原样保留空白，在宏名前加 `#` 标志位：

```text
{{#if .verbose}}
   这一段的缩进和首尾空白均会原样保留。
{{/if}}
```

### 转义

要输出字面的双花括号，前面加反斜杠：

```text
\{{not a macro}}
```

反斜杠在后处理阶段被去掉，原始的 <code v-pre>{{...}}</code> 字符串原样到达模型。这是在提示词中**教模型宏语法**、又不让示例真正执行的写法。

### 老式标签

一些非花括号的老式标签，会在宏解析前被自动重写：

| 老式 | 现代等价 |
|---|---|
| `<USER>` | <code v-pre>{{user}}</code> |
| `<BOT>` / `<CHAR>` | <code v-pre>{{char}}</code> |
| `<GROUP>` / `<CHARIFNOTGROUP>` | <code v-pre>{{group}}</code> / <code v-pre>{{charIfNotGroup}}</code> |

新内容用花括号写法。老式标签为向后兼容保留。

<code v-pre>{{time_UTC+N}}</code> 同样会被重写为 <code v-pre>{{time::UTC+N}}</code>。

## 变量简写

除了完整的 <code v-pre>{{getvar::name}}</code> / <code v-pre>{{setvar::name::value}}</code>，Luker 还提供一套**变量表达式**简写，读起来跟赋值语句一样：

| 写法 | 含义 | 返回 |
|---|---|---|
| <code v-pre>{{.name}}</code> | 读**局部**变量 | 当前值 |
| <code v-pre>{{$name}}</code> | 读**全局**变量 | 当前值 |
| <code v-pre>{{.name = 5}}</code> | 赋值 | `''`（空字符串） |
| <code v-pre>{{.name += 1}}</code> | 加（数值加 / 字符串拼接） | `''` |
| <code v-pre>{{.name -= 1}}</code> | 减，仅适用于数值，非数值会告警 | `''` |
| <code v-pre>{{.name++}}</code> | 自增 | `''` |
| <code v-pre>{{.name--}}</code> | 自减 | `''` |
| <code v-pre>{{.name ?? "default"}}</code> | 取值，**未定义**时取预设 | 值或预设 |
| <code v-pre>{{.name &#124;&#124; "default"}}</code> | 取值，**falsy** 时取预设 | 值或预设 |
| <code v-pre>{{.name ??= "x"}}</code> | 未定义时才赋值 | 新值 |
| <code v-pre>{{.name &#124;&#124;= "x"}}</code> | falsy 时才赋值 | 新值 |
| <code v-pre>{{.name == 5}}</code> | 字符串相等 | `"true"` / `"false"` |
| <code v-pre>{{.name != 5}}</code> | 字符串不等 | `"true"` / `"false"` |
| <code v-pre>{{.name > 5}}</code> | 数值 `>` | `"true"` / `"false"` |
| <code v-pre>{{.name >= 5}}</code> | 数值 `>=` | `"true"` / `"false"` |
| <code v-pre>{{.name < 5}}</code> | 数值 `<` | `"true"` / `"false"` |
| <code v-pre>{{.name <= 5}}</code> | 数值 `<=` | `"true"` / `"false"` |

`.` 永远指 chat 局部变量，`$` 永远指全局变量。两个作用域不共享命名。

变量表达式可以和控制流组合：

```text
{{if .hp <= 0}}
你死了。
{{else}}
你还剩 {{.hp}} 点 HP。
{{/if}}
```

变量名允许底线和连字号，但最后一个字符必须是 word 字符：`my-var` 合法，`my-` 不合法（会和 `--` 自减操作符冲突）。

::: tip 默认值惰性求值
`??` 和 `||` 只在变量缺失 / falsy 时才会求 fallback 表达式。这能让你跳过昂贵的默认值：<code v-pre>{{.cachedSummary ?? {{summary}}}}</code> 只在缓存未命中时才会调用 <code v-pre>{{summary}}</code>。
:::

## 控制流

### 条件 —— <code v-pre>{{if}}</code> / <code v-pre>{{else}}</code>

```text
{{if condition}}then-content{{/if}}
{{if condition}}then{{else}}otherwise{{/if}}
{{if !condition}}negated{{/if}}
```

condition 可以是：

- 字面值——空字符串、`false`、`off`、`0` 视为 falsy；其余均为 truthy。
- 已注册的宏名（不带花括号）——<code v-pre>{{if description}}# Description{{/if}}</code> 会先把 `description` 解析出来。
- 嵌套宏——<code v-pre>{{if {{getvar::showHeader}}}}...{{/if}}</code>。
- 变量简写——<code v-pre>{{if .ready}}</code>、<code v-pre>{{if $debugFlag}}</code>。
- 变量表达式——<code v-pre>{{if .hp > 0}}</code>。
- 以上任何一种前面加 `!` 取反——<code v-pre>{{if !.dead}}</code>。

::: tip 分支惰性求值
只有命中的那个分支里的嵌套宏才会被解析。<code v-pre>{{if .casting}}{{.mana -= 10}}{{/if}}</code> 在 `.casting` 为 false 时不会扣魔。把 <code v-pre>{{if}}</code> 套在昂贵或有副作用的宏外面是安全的。
:::

### 迭代 —— <code v-pre>{{each}}</code>

```text
{{each::collection}}
{{loop_key}}: {{loop_value}}
{{/each}}
```

`collection` 接受以下形式：

1. 内嵌 JSON 字面量——<code v-pre>{{each::["sword"，"shield"]}}</code> 或 <code v-pre>{{each::{"a":1，"b":2}}}</code>。
2. 变量名——<code v-pre>{{each::npcs}}</code> 读局部变量 `npcs`（找不到 fallback 到全局），并把字符串当 JSON 解析。
3. 解析结果为集合的嵌套宏——<code v-pre>{{each::{{getglobalvar::roster}}}}</code>。

body 里：

| 宏 | 含义 |
|---|---|
| <code v-pre>{{loop_key}}</code> | 当前 key（数组时是字符串形式的索引） |
| <code v-pre>{{loop_value}}</code> | 当前值整体（对象会自动 JSON 字符串化） |
| <code v-pre>{{loop_value::field}}</code> | 用点号路径深入值，语义同 <code v-pre>{{getvar}}</code> |

嵌套 <code v-pre>{{each}}</code> 会自然屏蔽外层的 `loop_key` / `loop_value`。对象按键的插入顺序迭代，数字键按升序。

空集合或不可迭代值渲染为空字符串。引擎**没有**对迭代次数加保护——body 里再次 <code v-pre>{{each}}</code> 自己负责防爆。

### 注解 —— <code v-pre>{{//}}</code>

行内：

```text
{{// 这一行被忽略}}
```

范围形式：

```text
{{//}}
多行注解。
里面可以写 {{宏}} 和 \{转义\}——什么都不会运行。
{{///}}
```

注解解析为空字符串。用于在提示词中留下说明，且不让模型读到。

## 变量

变量分两种作用域：

- **局部**——按聊天独立保存，记录在当前聊天的状态中。用来存聊天专属状态（HP、当前任务、回合数）。
- **全局**——跨所有聊天共享，存在扩展设置里。用来存跨 chat 计数器、插件设置。

### 读

| 宏 | 变量简写 | 用途 |
|---|---|---|
| <code v-pre>{{getvar::name}}</code> | <code v-pre>{{.name}}</code> | 读局部 |
| <code v-pre>{{getglobalvar::name}}</code> | <code v-pre>{{$name}}</code> | 读全局 |
| <code v-pre>{{hasvar::name}}</code>（别名 `varexists`） | —— | `"true"` / `"false"` |
| <code v-pre>{{hasglobalvar::name}}</code>（别名 `globalvarexists`） | —— | `"true"` / `"false"` |

不存在的变量返回空字符串。

### 写

| 宏 | 变量简写 | 用途 |
|---|---|---|
| <code v-pre>{{setvar::name::value}}</code> | <code v-pre>{{.name = value}}</code> | 设置局部 |
| <code v-pre>{{addvar::name::value}}</code> | <code v-pre>{{.name += value}}</code> | 加（数值）/ 拼接（字符串）/ push（JSON 数组） |
| <code v-pre>{{incvar::name}}</code> | <code v-pre>{{.name++}}</code> | +1 |
| <code v-pre>{{decvar::name}}</code> | <code v-pre>{{.name--}}</code> | -1 |
| <code v-pre>{{deletevar::name}}</code>（别名 `flushvar`） | —— | 删除 |
| <code v-pre>{{pushvar::name::value}}</code> | —— | 把 `value` 推入 `name` 中存储的 JSON 数组；缺失时自动建为 `[]`。支持点号路径（如 `roster.alice.inv`）。 |
| <code v-pre>{{popvar::name}}</code> | —— | 从 `name` 的 JSON 数组弹出最后一个元素；空或缺失时为无操作。支持点号路径。 |

全局对应的有 `setglobalvar` / `addglobalvar` / `incglobalvar` / `decglobalvar` / `deleteglobalvar`。

`addvar` 是重载的：两侧均为数值字符串时做数值加；现有值是 JSON 数组时 push；否则按字符串拼接。

::: tip 用 <code v-pre>{{noop}}</code> 锚住空白
拼接、范围宏 body、`+= "  text"` 等场景下，前导/尾部空白经常被引擎的自动整理或参数 trim 吃掉。在要保留的空白前后插一个 <code v-pre>{{noop}}</code>（解析为空字符串）就能锚住它。例如 <code v-pre>{{addvar::story::{{noop}}  这是新的一段。}}</code>。
:::

### 结构化值的点号路径

变量可以存任何 JSON 可序列化的值。当变量存的是 JSON 字符串化的对象 / 数组时，点号路径直接生效：

```text
{{setvar::npcs::{"alice":{"hp":40},"bob":{"hp":30}}}}
{{getvar::npcs.alice.hp}}    → 40
{{getvar::npcs.alice}}        → {"hp":40}
{{getvar::list.0}}            → list 的第一个元素
```

**写入也支持点号路径。** <code v-pre>{{setvar}}</code>、<code v-pre>{{deletevar}}</code>、<code v-pre>{{pushvar}}</code>、<code v-pre>{{popvar}}</code> 均接受点号路径名，因此可以在多轮叙事中维护同一个结构化变量，不必重写整盘。

```text
{{setvar::roster.alice.hp::50}}              <!-- 引入 Alice，初始 50 HP -->
{{setvar::roster.alice.mood::cautious}}      <!-- 设置她的情绪 -->
{{pushvar::roster.alice.inventory::dagger}}  <!-- 给她一把匕首 -->
{{pushvar::roster.alice.inventory::potion}}
{{incvar::roster.alice.hp}}                  <!-- 回 1 HP -->
{{popvar::roster.alice.inventory}}           <!-- 她使用了一件物品 -->
{{deletevar::roster.alice.mood}}             <!-- 情绪重置 -->
```

中间节点按需自动创建。纯数字路径段产生数组下标（例如 <code v-pre>{{setvar::log.0::一位老人到来}}</code> 写入 `log` 的第 0 个元素）。

对非 JSON 值使用点号路径时，引擎改为按字面键查找，名称确实为 `a.b` 的变量同样可以读取。

结构化值与 <code v-pre>{{each}}</code> 配合使用：NPC 名册、背包物品、任务日志均可存入同一个变量，在提示词组装时渲染进提示词或世界书条目：

```text
{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

### 单键读写 —— <code v-pre>{{getvarkey}}</code> / <code v-pre>{{setvarkey}}</code>

::: tip 两套寻址方式
本节的按键寻址宏族来自 SillyTavern 原版；[点号路径](#结构化值的点号路径)则是 Luker 的扩展，单个宏即可访问任意深度。为兼容面向原版 SillyTavern 编写的内容，两种写法均可用。
:::

SillyTavern 的按键寻址宏族可以直接使用：

| 宏 | 别名 | 作用域 |
|---|---|---|
| <code v-pre>{{getvarkey::name::key}}</code> | `getvarindex` | 局部 |
| <code v-pre>{{setvarkey::name::key::value}}</code> | `setvarindex` | 局部 |
| <code v-pre>{{getglobalvarkey::name::key}}</code> | `getglobalvarindex` | 全局 |
| <code v-pre>{{setglobalvarkey::name::key::value}}</code> | `setglobalvarindex` | 全局 |

它们读写 JSON 字符串化变量里的**单个**键（或数组下标）。键看起来是数字时会建成数组，否则建成对象：

```text
{{setvarkey::roster::alice::40}}[{{getvarkey::roster::alice}}]  → [40]
{{setvarkey::log::0::first}}{{setvarkey::log::1::second}}        → 键是数字，所以 `log` 是数组
[{{getvarkey::log::1}}]                                          → [second]
```

新写的内容建议优先用上面的[点号路径](#结构化值的点号路径)：一个宏就能抵达任意深度，写入也用同一套语法。`varkey` 只能处理一层，要写到 `roster.alice.hp` 得自己拼「读—改—写」。

它有一件点号路径做不到的事：键会被**原样**取用，所以当键本身含点号时只能用它。

```text
{{setvarkey::metrics::p95.latency::120}}   → 设置字面键 "p95.latency"
{{getvarkey::metrics::p95.latency}}        → 120
{{getvar::metrics.p95.latency}}            → 空：点号形式会在每个点处切分
```

### 逐楼层变量 {#per-message-variables}

原生 SillyTavern 里，副作用宏 <code v-pre>{{setvar::hp::50}}</code> 只在 *提示词模板* 里（预设、世界书、首楼）才会运行。AI 在回复里写同样的字面量什么都不会发生，还会原样显示出来污染叙事。

Luker 用**逐楼层变量提取**解决这个问题。一条消息（AI 回复、用户消息、swipe、续写）保存时，Luker 会：

1. 扫描文本里的 <code v-pre>{{setvar}}</code>、<code v-pre>{{addvar}}</code>、<code v-pre>{{incvar}}</code>、<code v-pre>{{decvar}}</code>、<code v-pre>{{deletevar}}</code>。
2. 把里面嵌套的展示宏（<code v-pre>{{user}}</code>、<code v-pre>{{getvar::other}}</code>、<code v-pre>{{time}}</code>……）对当前状态求值。
3. 把变更立刻应用到当前聊天的变量中。
4. 在该消息上追加一条变量变动记录。
5. 从可见文本里把字面量删掉。

当你删消息、切 swipe、重新生成、编辑时，Luker 会**重播剩余的 op log**，让变量状态跟可见的时间线保持一致。

这就是「**逐楼层变量**」面板背后的机制——带 op 的消息按钮栏会出现一个烧瓶图标，点开可以查看 / 编辑 / 删除 / 添加 op。结果就是 AI 能直接在自己回复里拥有和修改状态，而这个状态能扛住用户惯常的所有结构性操作。

完整的特性页面（重播语义、swipe 生命周期、op 编辑器、推荐的创作范式）见 [逐楼层变量](/zh-CN/features/variable-op-log)。

::: warning 全局变量不会被提取
<code v-pre>{{setglobalvar}}</code> 这一家不在逐楼层提取的范围内——全局状态是跨 chat 的，跟某条消息绑不到一起。它们保留原生 SillyTavern 的语义。
:::

## 内置宏目录

`/? macros` 会打开应用内浏览器，里面是同一份描述、能搜索、能看即时签名。

### 名称与参与方

| 宏 | 返回 |
|---|---|
| <code v-pre>{{user}}</code> | 当前 persona 名 |
| <code v-pre>{{char}}</code> | 当前角色名 |
| <code v-pre>{{group}}</code>（别名 `charIfNotGroup`） | 群聊成员名字（逗号分隔），单聊时是角色名 |
| <code v-pre>{{groupNotMuted}}</code> | 同 `group` 但排除被静音的成员 |
| <code v-pre>{{notChar}}</code> | 除当前发言者之外的所有参与方 |

### 角色卡字段

| 宏 | 返回 |
|---|---|
| <code v-pre>{{charDescription}}</code>（别名 `description`） | 描述字段 |
| <code v-pre>{{charPersonality}}</code>（别名 `personality`） | 人格字段 |
| <code v-pre>{{charScenario}}</code>（别名 `scenario`） | 场景字段 |
| <code v-pre>{{persona}}</code> | 当前 persona 描述 |
| <code v-pre>{{charPrompt}}</code> | 主提示词 override |
| <code v-pre>{{charInstruction}}</code> | Post-History Instructions override |
| <code v-pre>{{charDepthPrompt}}</code> | @ Depth Note |
| <code v-pre>{{charCreatorNotes}}</code>（别名 `creatorNotes`） | 作者笔记 |
| <code v-pre>{{charVersion}}</code> | 卡片版本号 |
| <code v-pre>{{charFirstMessage}}</code>（别名 `greeting`） | 主问候语（索引 0） |
| <code v-pre>{{greeting::N}}</code> | 第 N 条问候语——0 是主，1+ 是 alt greetings |
| <code v-pre>{{mesExamples}}</code> | 对话示例，启用 instruct 时自动按 instruct 格式化 |
| <code v-pre>{{mesExamplesRaw}}</code> | 对话示例原文 |
| <code v-pre>{{original}}</code> | 角色级覆盖中的原始提示词内容。**单次有效**：同一次替换中第二次调用返回 `""`。仅在 `charPrompt` / `charInstruction` 内有效。 |

### 聊天状态

| 宏 | 返回 |
|---|---|
| <code v-pre>{{lastMessage}}</code> | 最后一条消息的文本 |
| <code v-pre>{{lastMessageId}}</code> | 最后一条消息的索引 |
| <code v-pre>{{lastUserMessage}}</code> | 最后一条用户消息文本 |
| <code v-pre>{{lastCharMessage}}</code> | 最后一条角色消息文本 |
| <code v-pre>{{firstIncludedMessageId}}</code> | 当前 context 窗口里第一条消息的索引 |
| <code v-pre>{{firstDisplayedMessageId}}</code> | 聊天卷动区里第一条可见消息的索引 |
| <code v-pre>{{lastSwipeId}}</code> | 最后一条消息的 swipe 数（1-based） |
| <code v-pre>{{currentSwipeId}}</code> | 当前活跃 swipe 的索引（1-based） |
| <code v-pre>{{allChatRange}}</code> | 形如 `0-12` 的全消息范围字符串，空 chat 时是空字符串 |
| <code v-pre>{{idleDuration}}</code>（别名 `idle_duration`） | 距上一次用户消息的可读时长 |
| <code v-pre>{{lastGenerationType}}</code> | `normal` / `impersonate` / `regenerate` / `quiet` / `swipe` / `continue` |

### 时间与日期

| 宏 | 返回 |
|---|---|
| <code v-pre>{{time}}</code> | 本地时间（locale 短格式，如 `3:45 PM`） |
| <code v-pre>{{time::UTC+2}}</code> | 指定 UTC 偏移的本地时间 |
| <code v-pre>{{date}}</code> | 本地日期（locale 长格式） |
| <code v-pre>{{weekday}}</code> | 星期名（`Monday`、……） |
| <code v-pre>{{isotime}}</code> | `HH:mm` |
| <code v-pre>{{isodate}}</code> | `YYYY-MM-DD` |
| <code v-pre>{{datetimeformat::FORMAT}}</code> | 用 moment.js 格式字符串渲染当前时间 |
| <code v-pre>{{timeDiff::A::B}}</code> | 两个时间之间可读的绝对差 |

### 变量

完整列表见上面的 [变量](#变量) 一节。

### 控制流与工具

| 宏 | 返回 |
|---|---|
| <code v-pre>{{if cond}}…{{/if}}</code> | 条件内容 |
| <code v-pre>{{else}}</code> | 在 <code v-pre>{{if}}</code> 里标记 else 分支 |
| <code v-pre>{{each::col}}…{{/each}}</code> | 迭代 |
| <code v-pre>{{loop_key}}</code> / <code v-pre>{{loop_value}}</code> / <code v-pre>{{loop_value::path}}</code> | 在 <code v-pre>{{each}}</code> body 里 |
| <code v-pre>{{trim}}</code> | 行内：后处理时把宏周围的换行删掉。范围形式：返回剥掉首尾空白后的内容 |
| <code v-pre>{{newline}}</code> / <code v-pre>{{newline::N}}</code> | 1 个或 N 个换行 |
| <code v-pre>{{space}}</code> / <code v-pre>{{space::N}}</code> | 1 个或 N 个空格 |
| <code v-pre>{{noop}}</code> | 空字符串。在拼接 / 范围宏里作为空白锚点很好用 |
| <code v-pre>{{reverse::text}}</code> | 反转字符串 |
| <code v-pre>{{//comment}}</code>（别名 `comment`） | 注解（输出为空） |

### 随机

| 宏 | 返回 |
|---|---|
| <code v-pre>{{roll::1d20}}</code> | 用 droll 语法掷骰（`1d6`、`3d6+4`……）。只有数字 `N` 时等价 `1dN`。每次渲染均重掷。 |
| <code v-pre>{{random::red::green::blue}}</code> | 随机一项。每次渲染均重掷。 |
| <code v-pre>{{pick::red::green::blue}}</code> | 随机一项，但**对同一 chat 同一位置稳定**。Seed = chat hash + content hash + 位置 + reroll seed。用 `/reroll-pick` 重置。 |

### 环境与 API

| 宏 | 返回 |
|---|---|
| <code v-pre>{{model}}</code> | 当前 model 识别字 |
| <code v-pre>{{maxPrompt}}</code>（别名 `maxPromptTokens`） | 提示词上下文 token 上限 |
| <code v-pre>{{maxContext}}</code>（别名 `maxContextTokens`） | 上下文 token 上限 |
| <code v-pre>{{maxResponse}}</code>（别名 `maxResponseTokens`） | 响应 token 上限 |
| <code v-pre>{{isMobile}}</code> | 行动设备时 `"true"` |
| <code v-pre>{{hasExtension::name}}</code> | 指定扩展已加载**且**启用时 `"true"` |
| <code v-pre>{{input}}</code> | 当前输入框内容 |
| <code v-pre>{{outlet::key}}</code> | 指定 key 的世界书 outlet 内容 |
| <code v-pre>{{banned::word}}</code> | 给 Text Completion 后端注册一个 banned word；返回空 |

### 作者笔记与摘要

| 宏 | 返回 |
|---|---|
| <code v-pre>{{authorsNote}}</code> | 当前 chat 生效的作者笔记 |
| <code v-pre>{{charAuthorsNote}}</code> | 角色级作者笔记 |
| <code v-pre>{{defaultAuthorsNote}}</code> | 预设作者笔记 |
| <code v-pre>{{summary}}</code> | 聊天摘要——只在 Summarize 扩展加载后才注册 |

### 推理范本

| 宏 | 返回 |
|---|---|
| <code v-pre>{{reasoningPrefix}}</code> | 推理段前缀 |
| <code v-pre>{{reasoningSuffix}}</code> | 推理段后缀 |
| <code v-pre>{{reasoningSeparator}}</code> | 推理与答案之间的分隔 |

### Instruct 与系统提示词

下列宏仅在对应的指令模板或系统提示词开关启用时返回内容。

| 宏 | 返回 |
|---|---|
| <code v-pre>{{systemPrompt}}</code> | 当前生效的系统提示词。启用 **Prefer Character Prompt** 时会切到 <code v-pre>{{charPrompt}}</code>。 |
| <code v-pre>{{defaultSystemPrompt}}</code>（别名 `instructSystem`、`instructSystemPrompt`） | 设置的预设系统提示词 |
| <code v-pre>{{instructStoryStringPrefix}}</code> / <code v-pre>{{instructStoryStringSuffix}}</code> | story string 包裹 |
| <code v-pre>{{instructUserPrefix}}</code>（别名 `instructInput`） / <code v-pre>{{instructUserSuffix}}</code> | 用户回合 sequence |
| <code v-pre>{{instructAssistantPrefix}}</code>（别名 `instructOutput`） / <code v-pre>{{instructAssistantSuffix}}</code>（别名 `instructSeparator`） | 助理回合 sequence |
| <code v-pre>{{instructFirstAssistantPrefix}}</code>（别名 `instructFirstOutputPrefix`） / <code v-pre>{{instructLastAssistantPrefix}}</code>（别名 `instructLastOutputPrefix`） | 首 / 末助理变体 |
| <code v-pre>{{instructFirstUserPrefix}}</code>（别名 `instructFirstInput`） / <code v-pre>{{instructLastUserPrefix}}</code>（别名 `instructLastInput`） | 首 / 末用户变体 |
| <code v-pre>{{instructSystemPrefix}}</code> / <code v-pre>{{instructSystemSuffix}}</code> | 系统回合 sequence |
| <code v-pre>{{instructSystemInstructionPrefix}}</code> | last-system sequence |
| <code v-pre>{{instructStop}}</code> | stop sequence |
| <code v-pre>{{instructUserFiller}}</code> | 对齐填充 |
| <code v-pre>{{exampleSeparator}}</code>（别名 `chatSeparator`） / <code v-pre>{{chatStart}}</code> | context 范本标记 |

### 扩展注册

只在对应扩展安装且启用时才存在：

| 宏 | 来源 | 返回 |
|---|---|---|
| <code v-pre>{{charPrefix}}</code> | Stable Diffusion | 正面图像生成提示词前缀 |
| <code v-pre>{{charNegativePrefix}}</code> | Stable Diffusion | 负面图像生成提示词前缀 |
| <code v-pre>{{summary}}</code> | Summarize | 保存的聊天摘要 |

第三方扩展可以注册更多宏，宏浏览器会标出每个宏的来源。

## 标志位

标志位是放在开头 <code v-pre>{{</code> 和宏名之间的单字符，用来改变宏的解析或求值行为。

### `/` —— 闭合标记

标记一个标签是范围宏的闭合半边。和同名的开标签配对，把两者之间的内容作为宏的**最后一个位置参数**传入：

```text
{{if .ready}} ...body... {{/if}}
{{each::npcs}} ...body... {{/each}}
{{setvar::longText}} ...body... {{/setvar}}
```

闭合标签自身不接受参数。

### `#` —— 保留空白

**只对范围宏有效。** 默认情况下，引擎会先对 body 做自动整理（剥掉首尾空白，再把第一个非空行的公共前导缩进从所有行里减掉）才交给 handler。加上 `#` 标志会跳过这一步，body 原样传入：

```text
{{#if .verbose}}
    这 4 空格缩进
    以及首尾的换行均会原样保留。
{{/if}}
```

这个标志也兼容老的 Handlebars 风格写法 <code v-pre>{{#if …}}</code> —— 跟 <code v-pre>{{if …}}</code> + 不自动 trim 等价。

加在非范围宏前面时，`#` 被接受但没有任何效果。

### `!` `?` `~` `>` —— 预留未实现

| 标志位 | 预期含义 | 现状 |
|---|---|---|
| `!` | 比同段文本里的其他宏先解析 | 仅解析 |
| `?` | 比其他宏后解析 | 仅解析 |
| `~` | 标记为可重新求值 | 仅解析 |
| `>` | 把 `\|` 当输出过滤器的管道 | 无效果（见下文 *管道符*）|

这些 token 解析器能识别，但运行时没有任何 hook 消费它们。<code v-pre>{{if !.dead}}</code> 里的 `!` 是另一回事——那是 <code v-pre>{{if}}</code> 内部的条件取反，不是这里的标志位。

标志位之间、标志位和宏名之间均允许空白，多个可以组合：<code v-pre>{{ #each ::list}} … {{/each}}</code>。

### `|` —— 管道符（普通字符）

::: tip 与 SillyTavern 的差异
原版 SillyTavern 将管道符解析为参数终止符，并支持 <code v-pre>{{macro|uppercase}}</code> 一类输出修饰器。该实现在上游被暂时禁用（issue #5618），Luker 遵循上游的词法分析器，因此本节描述的行为与上游保持一致。
:::

管道符在宏参数里没有特殊含义。lexer 不把 `|` 当参数终止符，所以它是普通内容，会原样传给宏：

```text
{{setvar::menu::sword | shield | bow}}   → 存入 "sword | shield | bow"
{{getvar::name|filter}}                  → 读取名为 `name|filter` 的变量
```

管道符没有转义写法；反斜杠会被原样存入：

```text
{{setvar::k::a \| b}}   → 存入 "a \| b"
```

::: warning 输出修饰器不可用
<code v-pre>{{macro|uppercase}}</code> 不会把任何内容转大写。需要字符串变换的话，请注册自定义宏，或使用 regex 扩展。
:::

## 斜杠命令里的管道宏 —— <code v-pre>{{pipe}}</code>、<code v-pre>{{var::name}}</code>

在**斜杠命令闭包**里（STscript —— `/command1 | /command2 | …` 链式调用、Quick Reply 等），斜杠命令作用域会再绑两个宏：

| 宏 | 作用域 | 含义 |
|---|---|---|
| <code v-pre>{{pipe}}</code> | 斜杠命令闭包 | 上一条命令的输出 |
| <code v-pre>{{var::name}}</code> | 斜杠命令闭包 | 用 `/let` / `/var` 创建的闭包内变量。**和聊天变量（用 <code v-pre>{{getvar::name}}</code> 访问）不是一回事** |

这两个只在斜杠命令解析器里存在。不在 STscript 上下文里出现时，它们会原样输出。

STscript 里的 `|` 是命令管道符，那是命令解析器的特性，不是宏引擎的。在单个宏的参数内部，`|` 按上面*管道符*那一节的规则处理。

## 解析语义

引擎一次性扫每段文本，从左到右展开宏。

- **嵌套宏**先解析，外层拿到的是已经求值完的字符串参数。除非该宏定义打开 `delayArgResolution`（当前只有 <code v-pre>{{if}}</code> 和 <code v-pre>{{each}}</code>）。
- **副作用宏**（<code v-pre>{{setvar}}</code>、<code v-pre>{{addvar}}</code>、<code v-pre>{{incvar}}</code>、<code v-pre>{{decvar}}</code>、<code v-pre>{{deletevar}}</code>）立即生效，同一 pass 里后面的宏能读到新值。
- **逐楼层提取**（见 [逐楼层变量](#per-message-variables)）发生在**消息保存时**，不是 提示词组装时。
- **未知宏**保留原始 <code v-pre>{{...}}</code>（嵌套参数仍会展开）。
- **参数数量或类型不匹配**：该宏不展开，按原样输出，控制台记录一条警告；同一段文本中的其他宏照常解析。
- **结果规范化**——每个 handler 的返回均会被规范化：`null` / `undefined` → `''`，`Date` → ISO 字符串，数组 / 对象 → `JSON.stringify(...)`，其他 → `String(...)`。这就是 <code v-pre>{{loop_value}}</code> 对一个对象会输出 JSON 的原因。
- **后处理清扫**——残留的 <code v-pre>{{trim}}</code> 标记和零散的 `else` 哨兵字符会在后处理里被清掉。

## 自定义宏

安装的插件可以向系统注册自定义宏。注册后的宏可以在世界书、预设和聊天消息中直接使用，并能在宏浏览器中查看其说明与示例。开发者若需编写自定义宏，请参阅 [扩展 API · 宏与变量](/zh-CN/development/extension-api/macros-and-variables)。

## 探索与调试

- 在解析宏的字段中输入 <code v-pre>{{</code> 会触发自动补全，按 **Ctrl+Space** 可随时打开。
- 在 **设置 → 自动补全设置 → 在所有宏字段中显示** 里把全局补全打开。
- 运行 `/? macros`（或 `/? macro` / `/? 4`）打开 **宏浏览器**：一个可搜索的弹窗，列出已注册的宏、分类、别名、参数、返回类型、示例与来源。
- 运行 `/reroll-pick` 重置当前 chat 里所有 <code v-pre>{{pick}}</code> 的结果。可传一个种子（`/reroll-pick mySeed`）以重现。

## 宏在哪些字段里生效

会进入提示词的文本字段：

- 角色卡字段（描述、性格、场景、首条消息、备选开场白、对话示例、深度提示、角色提示词）
- 世界书条目正文、key、header
- 预设中的提示词条目
- 作者笔记
- 聊天消息（用户和 AI），带逐楼层变量提取
- 斜杠命令参数与 Quick Reply 脚本
- 正则扩展的替换文本
- 宏自身的参数（嵌套）

## 常见范式

### 预设里的条件段

```text
{{if .difficulty == "hard"}}
世界冷酷无情，失败不可逆。
{{else}}
世界宽容，死亡只是挫折，不是终点。
{{/if}}
```

### 一个能扛住 swipe 和删除的计数器

在角色卡的 `first_mes` 或 alt greeting 里初始化变量：

```text
{{setvar::turn::0}}
```

在 AI 回复里（通过一条指示 AI 写这个的世界书条目），让 AI 自己 incr：

```text
{{incvar::turn}}
```

逐楼层提取会把字面量删掉、把 op 记下来，用户看到的是干净叙事、变量正常递增。删那条消息时，重播会把 op 撤掉。

### 对当前 chat 稳定的随机选择

```text
{{pick::酒馆斗殴::一个安静的夜晚::不速之客}}
```

掷一次后，对该 chat 的该位置就锁住了——这种「今天的氛围」式的随机就该在重渲染里不抖。

### 渲染一个结构化集合

```text
# 进行中的任务
{{each::quests}}{{if {{loop_value::status}} == "active"}}
- {{loop_value::name}}
{{/if}}{{/each}}
```

AI 用 <code v-pre>{{setvar::quests::…}}</code> 在回复里维护 `quests` 结构；上面那段写在世界书里，提示词组装时按当前状态铺开。

### 根据 flag 切换的作者笔记

```text
{{if $debug_verbose}}
[叙事声音：把推理过程讲得格外清楚]
{{/if}}
```

从 Quick Reply 或斜杠命令切换的全局标志，成为一个按需启用的命令，需要时随提示词一同发送。

## 参考

- [逐楼层变量](/zh-CN/features/variable-op-log) —— 楼层变量特性的完整说明。
- [Extension API · 宏与变量](/zh-CN/development/extension-api/macros-and-variables) —— 在插件里注册自定义宏。
- [世界书基础](/zh-CN/basics/world-info) —— 大部分提示词宏的使用场景。
- [预设系统](/zh-CN/basics/presets) —— 提示词宏的另一处使用场景。
