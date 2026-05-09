# 逐楼层变量

Luker 在 SillyTavern 原生变量系统之上引入了**逐楼层变量**：AI 回复里写的变量赋值会被自动提取、结构化、随消息一起保存，并在聊天历史发生变化时被确定性地重放——删除消息、切换 swipe、重新生成回复后，你的变量自动落到正确状态。

## 为什么需要这个

原生 SillyTavern 里，副作用宏 <code v-pre>{{setvar::hp::50}}</code> 只在它出现在 *prompt 模板* 里（预设、世界书、首楼）时才会被执行。如果 AI 在回复里写了同样的字面量，什么都不会发生——它就是一段普通文本。更糟的是字面量会原样显示给用户，污染叙事。

Luker 的解法：在保存 AI / 用户消息时把副作用宏从文本里提取出来，作为结构化操作挂在那条消息上，需要时重放。字面量从可见文本里消失，操作作为数据被保留。

## 工作原理

```d2
direction: down

AI: "AI 回复 / 用户消息保存"
EXTRACT: "扫描 mes 提取副作用宏\nsetvar / addvar / incvar / decvar / deletevar" {
  style.fill: "#e1f5ff"
}
EVAL: "嵌套展示型宏求值\n{{user}} / {{getvar}} / {{time}} ..."
APPLY: "前向 apply 到\nchat_metadata.variables"
LOG: "结构化记录追加到\nmessage.extra.var_ops"
CLEAN: "字面量从 mes 里删除"
DISPLAY: "聊天界面看到的是\n干净叙事"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "聊天结构变化" {
  shape: diamond
}
DEL: "MESSAGE_DELETED"
SWIPE: "MESSAGE_SWIPED"
SWIPED: "MESSAGE_SWIPE_DELETED"
CHANGED: "CHAT_CHANGED"
EDIT: "MESSAGE_EDITED"
REBUILD: "从存活 op 重放\n仅动 op 日志里出现的 key" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
CHANGED -> REPLAY
EDIT -> REPLAY
REPLAY -> REBUILD
```

### 提取

消息保存时（AI 回复、续写、重新生成、swipe、用户消息），Luker 扫描 `mes` 寻找下面这些副作用宏：

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>

按出现顺序逐个处理：

1. value 里嵌套的**展示型**宏（<code v-pre>{{user}}</code>、<code v-pre>{{getvar::other_key}}</code>、<code v-pre>{{time}}</code> 等）针对当前状态求值。
2. op 立即前向 apply 到 `chat_metadata.variables`，这样同一条消息里后续的 op 能读到结果。
3. 结构化记录追加到 `message.extra.var_ops`。
4. 字面量从 `mes` 里删掉。

聊天界面看到的就是干净叙事；变量是最新的；操作历史可查询。

::: info 顺序求值
同一条消息里两个相互依赖的 op 会按预期工作：

```
{{setvar::a::1}} {{setvar::b::{{getvar::a}}}}
```

提取完成后：`a = 1`，`b = 1`。每个宏都是先完整求值再 apply，再处理下一个。
:::

### 结构性变化时重放

聊天结构变化时，Luker 重建变量缓存的相关部分：

| 事件 | 动作 |
|------|------|
| `MESSAGE_DELETED` | 从存活 op 重放；只有出现在存活日志里的 key 会被改动 |
| `MESSAGE_SWIPED` | 重放（活跃 swipe 的 `extra.var_ops` 此时已就位） |
| `MESSAGE_SWIPE_DELETED` | 重放 |
| `CHAT_CHANGED` | 针对刚加载的 chat 重放 |
| `MESSAGE_EDITED` | 重放（**不**重新提取——编辑叙事不会触发 setvar） |

重放是刻意保守的：只动那些出现在存活 op 日志里的 key。其他来源写的变量——世界书副作用、slash 命令、Quick Reply、第三方扩展、老 chat 遗留——一律不动。

### Swipe 生命周期

`var_ops` 挂在 `message.extra` 上，SillyTavern 已经通过 `swipe_info[i].extra` 自动镜像到每个 swipe。切换 swipe 时正确的 op 自动跟过来。

新 swipe 开始生成时，`clearMessageData` 会丢掉前一个 swipe 的 `var_ops`（Luker 把它加进了白名单），这样提取从干净状态开始。

### 续写

续写会把新 token 追加到现有 `mes` 后面。因为之前的提取已经把字面量从 `mes` 里删干净了，下一次提取只会看到新增部分，把新 op 追加到同一个 `var_ops` 数组末尾。不需要时间戳、偏移量、标志位。

## 操作面板

任何带有 op 日志的消息按钮排上会出现一个小烧瓶图标：

![楼层消息上的小烧瓶图标](/images/variable-op-log/var-ops-flask-button.png)

点开能：

- 查看这条消息记录的所有操作
- 编辑某个操作的 `op` / `key` / `value`
- 删除某个操作
- 新增操作

![Variable operations 面板](/images/variable-op-log/var-ops-panel.png)

保存时该消息的 op 数组被你的编辑替换、缓存重建、聊天落盘。**手动调整变量推荐这条路**——它把改动落在时间线上一个具体的消息上，未来的结构性变化（删除、swipe）能正确保留意图。

## 与其他变量来源的共存

| 来源 | 行为 |
|------|------|
| 世界书 <code v-pre>{{setvar}}</code> | 走 SillyTavern 原生流程，prompt 组装时执行；缓存里这个 key 每轮都会被 WI 的值覆盖。如果想让 WI 充当「初始化」而不是「每轮覆盖」，把这类条目放在高 depth / prompt 最前。 |
| 预设 <code v-pre>{{setvar}}</code> | 同世界书。 |
| Slash 命令 `/setvar` | 直接写 `chat_metadata.variables`。下次重放扫到同名 key（即存活的 AI op 提到了这个 key）时会被覆盖。 |
| Quick Reply 脚本 | 同 slash 命令。给 QR 管理的变量起一个 AI op 不会碰的名字。 |
| <code v-pre>{{setglobalvar}}</code> 系列 | 不被提取。全局变量在 chat-local op 日志的范围之外，按原生语义工作。 |

## 角色卡作者建议

如果一个变量打算让 **AI 在 RP 过程中拥有并修改**，就只让它通过 AI 写的 <code v-pre>{{setvar}}</code> 来变化，不要从世界书或 QR 里再写。

如果一个变量打算 **chat 开始时初始化一次**，把它写在角色卡的首楼或 alt greeting 里——它们也会被提取到 `chat[0].extra.var_ops`。

如果一个变量打算 **每轮 prompt 组装时按当前情境重算**（比如根据当前位置算天气），就放世界书；缓存被覆盖是预期行为。

## 何时使用变量驱动 UI

当某些字段需要随对话推进而变化、并被某种 UI 消费（CardApp 面板、世界书条目、自定义渲染器等）时，把它们建模成 chat 变量。生产端三种途径：

1. `first_mes` / alt greetings 里 setvar 兜底初始值
2. 世界书条目里指引 AI 在 reply 中用 setvar 改写
3. AI 在 reply 中 emit setvar 直接更新

消费端通过 `getvar` 读取，UI 在每次 `chat_metadata` 变化时重新渲染。

这种模式适合"叙事 header"类数据——例如当前章节阶段、任务进度、地点状态、案件名等需要随情节推进而变化的字段。

## 存储结构

```jsonc
chat[i] = {
    "mes": "...剥离了副作用宏的叙事...",
    "extra": {
        "var_ops": [
            { "op": "setvar", "key": "hp", "value": "50" },
            { "op": "incvar", "key": "turn" }
        ]
    },
    "swipe_info": [
        { "extra": { "var_ops": [...] } },
        { "extra": { "var_ops": [...] } }
    ]
}
```

`chat_metadata.variables` 仍是 SillyTavern 原生缓存，是 <code v-pre>{{getvar}}</code> 的真源。op 日志是我们拥有的那部分值的 *来源*；缓存是所有来源合并后的运行时视图。
