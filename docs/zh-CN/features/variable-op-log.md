# 逐楼层变量

角色扮演里的状态常常写在 AI 回复中：体力降到 40、拿到一把匕首、某位 NPC 离队。逐楼层变量让这些变量赋值真正生效，并与聊天历史保持一致：删除消息、切换 swipe、重新生成后，变量会回到当前时间线应有的状态。

## 解决什么问题

在原生 SillyTavern 中，<code v-pre>{{setvar::hp::50}}</code> 只有在预设、世界书或首楼等提示词模板里才会执行。AI 在回复里写同样的内容，不会改变任何变量，还会把这一段字面量显示给用户，打断叙事。

Luker 在保存消息时把这类赋值提取出来，作为该条消息的一部分保存，并从可见文本中移除。变量立即更新；消息删除或切换 swipe 时，Luker 按仍存在的赋值重新计算。

```d2
direction: down

AI: "回复写入聊天"
EXTRACT: "从消息中提取赋值宏\nsetvar / addvar / incvar / decvar / deletevar / pushvar / popvar" {
  style.fill: "#e1f5ff"
}
EVAL: "解析嵌套的展示宏"
APPLY: "写入当前变量"
LOG: "在消息上记录本次变量操作"
CLEAN: "从可见文本中移出赋值"
DISPLAY: "聊天界面显示纯叙事"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "聊天结构变化" {
  shape: diamond
}
DEL: "删除消息"
SWIPE: "切换 swipe"
SWIPED: "删除 swipe"
EDIT: "编辑消息"
CHANGED: "切换聊天"
REBUILD: "按仍有效的赋值重新计算" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
EDIT -> REPLAY
CHANGED -> REPLAY
REPLAY -> REBUILD
```

## 支持的写法

以下赋值会从消息中提取：

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>
- <code v-pre>{{pushvar::name::value}}</code>
- <code v-pre>{{popvar::name}}</code>

变量名支持点号路径，例如 <code v-pre>{{setvar::roster.alice.hp::50}}</code>。同一条消息中的赋值按出现顺序执行，后面的赋值可以读取前面的结果。

值里嵌套的展示宏会先按当前状态求值，例如 <code v-pre>{{setvar::greeting::{{user}}}}</code> 会写入当前用户名称。

## 编辑和查看

带有变量操作的消息会出现一个烧瓶图标。点开后可以：

- 查看这条消息记录的所有操作
- 修改操作类型、变量名或值
- 删除某条操作
- 新增操作

保存后，变量会按修改后的记录重新计算。手动调整变量时优先用这个面板：改动落在具体消息上，之后的删除与 swipe 会正确处理。

## 删除、编辑与 swipe

Luker 只回放当前聊天中存在的变量操作。删除一条消息时，这条消息写过的变量会回退到之前的状态；切换 swipe 时，变量跟随当前 swipe 的记录；编辑消息正文不会重新提取赋值，需要修改时请用烧瓶面板。

重放只影响变量操作记录中出现的顶层变量名。世界书、斜杠命令、Quick Reply 和第三方扩展写入的变量不会被覆盖。

## 与其他变量来源共存

| 来源 | 行为 |
| --- | --- |
| 世界书 <code v-pre>{{setvar}}</code> | 在提示词组装时执行，每轮都会覆盖同名变量。适合初始化或按当前情境重算的值。 |
| 预设 <code v-pre>{{setvar}}</code> | 与世界书相同。 |
| 斜杠命令 `/setvar` | 直接写入聊天变量。如果之后的消息操作也写了同一个变量，重放时会以消息记录为准。 |
| Quick Reply | 同斜杠命令。给 Quick Reply 管理的变量起一个 AI 不会使用的名字。 |
| <code v-pre>{{setglobalvar}}</code> 系列 | 不参与逐楼层提取。全局变量跨聊天共享，按原生语义工作。 |

## 给角色卡作者的建议

- 希望 AI 在剧情中修改的变量，只让 AI 通过回复里的赋值来改，不要再从世界书或 Quick Reply 重复写入。
- 只在聊天开始时初始化一次的变量，写在首楼或备选开场白里。
- 每轮都要按当前情境重算的变量，放在世界书里，让提示词组装时覆盖。
- 需要随剧情推进的面板数据，建模成聊天变量：开场白初始化，世界书条目指导 AI 更新，CardApp 读取并渲染。

## 结构化变量

一个变量可以保存完整的结构化数据：NPC 名册、队伍物品、任务日志、关系表。AI 每次只改其中一项，不必重写整个结构。

```text
{{setvar::roster.alice.hp::50}}
{{setvar::roster.alice.mood::cautious}}
{{pushvar::roster.alice.inventory::dagger}}
{{setvar::roster.alice.hp::40}}
{{deletevar::roster.bob}}
```

删除消息或切换 swipe 时，整个结构按聊天中存在的操作重建，改动落在对应的叶子上。

渲染时用 <code v-pre>{{each}}</code> 遍历：

```text
{{each::roster}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

<code v-pre>{{loop_key}}</code> 是当前键，<code v-pre>{{loop_value}}</code> 是完整值，<code v-pre>{{loop_value::field}}</code> 读取其中的字段。集合也可以直接写成内联数组或嵌套宏。

## 相关页面

- [宏](/zh-CN/basics/macros) —— 变量宏的完整语法
- [世界书基础](/zh-CN/basics/world-info) —— 用条目指导 AI 更新变量
- [CardApp](/zh-CN/features/cardapp) —— 读取变量并渲染界面
