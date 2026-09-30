# 角色卡替换流程

用户在角色管理菜单中执行**替换 / 更新**时，新卡文件会覆盖旧卡 PNG。聊天、资源和群组成员关系会保留，但旧卡存在 `data.extensions.*` 里的一切、以及角色卡的世界书状态，都需要核心来协调。核心通过两个按顺序运行的注册表承担这份协调，时机都在 `CHARACTER_REPLACED` 事件发出之前：

1. **卡绑定保护** —— 槽位注册表：新卡缺少的本地绑定静默写回，冲突的弹窗询问。
2. **替换后世界书动作** —— 动作注册表：决定世界书的去向——导入新卡的内嵌世界书、保留原来绑定的世界书、或执行插件注册的动作。

两个注册表共享同一套形态：属主在扩展 init 中注册描述符，核心不硬编码插件语义；被禁用的插件不会注册——它的保护/动作随之消失，而核心自己的始终生效。

## 流程顺序

```text
替换 / 更新（文件或 URL）
  → 新卡原样导入同一 avatar
  → 卡绑定保护引擎              （槽位注册表）
  → 替换后世界书弹窗            （动作注册表）
  → 发出 CHARACTER_REPLACED
```

两步都在 `emitCharacterReplacedEvent` 内部、任何监听器被通知之前运行，因此写入发生在插件响应事件之前。世界书这一步是 await 的：如果某个动作打开了长时间存在的界面（例如角色卡编辑助手的合并工作台），事件会推迟到界面关闭之后，监听器随后看到的是已定状态——要么新书已绑定，要么回滚已恢复旧书。

## 第一部分 —— 卡绑定保护

没有保护机制时，存在 `data.extensions.*` 里的本地绑定——绑定的对话补全预设、角色专属人设、编排的本卡预设、记忆图定制、CardApp 开关——都会随旧卡一起丢失。槽位注册表保护它们。引擎会针对每个已注册槽位比较旧卡和新卡：

- **仅旧卡有** —— 旧卡配置了该绑定，新卡没有。引擎静默写回本地值。
- **冲突** —— 两张卡都定义了该绑定且值不同。弹窗逐类列出冲突项，用户可按类选择保留本地值或采用新卡的值。
- **相同** —— 值深度相等，不做任何处理。
- **仅新卡有** —— 新卡自带的绑定原样保留（与普通导入一致）。

### 注册槽位

属主在扩展 init 中为每个绑定类别注册一个描述符：

```js
const context = Luker.getContext();

context.registerCardBindingSlot({
    id: 'my-binding',
    label: () => context.translate('My binding'),
    read: character => readMyBinding(character),
    isPresent: value => Boolean(value),
    summarize: value => summarizeMyBinding(value),
    write: async (characterId, value) => {
        const previous = context.characters[characterId]?.data?.extensions?.my_namespace;
        await context.writeExtensionField(characterId, 'my_namespace', { ...previous, my_binding: value });
    },
});
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 唯一且稳定的槽位 id。仅允许字母、数字、`_` 和 `-`，且必须以字母开头。重复注册同一 id 会打印警告并覆盖旧描述符。 |
| `label` | `() => string` | 用户可见的类别名称，由属主负责翻译。 |
| `read` | `(character) => value \| null` | 从角色对象纯读取，不得调度写入或迁移。 |
| `isPresent` | `(value) => boolean` | 该值是否算作用户配置过。 |
| `summarize` | `(value) => string` | 冲突弹窗中该侧的一行摘要。 |
| `write` | `async (characterId, value) => void` | 写回值。`characterId` 是 `context.characters` 的下标。 |

描述符缺少必需函数时 `registerCardBindingSlot` 会直接抛错，让错误在加载期暴露，而不是等到替换发生。

### 写回责任

`write` 只收到 `read` 产出的值。属主需要：

- 通过 `context.characters[characterId]` 解析角色；
- 合并兄弟键——`context.writeExtensionField` 会整体替换该命名空间的值，先读取当前数据再展开、覆盖被保护的键；
- 失败时抛错。引擎会 toast 报错并继续处理其余槽位，绝不阻断替换。

### 已禁用的插件

槽位在扩展 init 时注册。被禁用或未加载的插件不会注册槽位，因此其卡绑定在替换时不受保护。这是有意为之：引擎不硬编码插件的字段语义。核心绑定（绑定预设、角色专属人设）始终受保护。

当绑定预设被保留时，引擎还会重新应用角色卡绑定预设，让当前会话采用保留的默认预设。

## 第二部分 —— 替换后世界书动作

绑定保护之后，核心会执行一步决策：只要本次替换存在至少一个可用动作，就会弹出对话框询问用户如何处理角色卡的世界书。核心注册两个动作——「导入新世界书」（把新卡自带的内置世界书另存为独立文件并绑定）和「保留旧世界书」（重新绑定原来的主世界书）。扩展可以注册更多动作。

### 注册动作

```js
const ctx = Luker.getContext();

ctx.registerPostReplaceAction({
    id: 'my-action',
    label: () => ctx.translate('My action'),
    description: (detail) => ctx.translate('What this action does.'),
    isAvailable: (detail) => detail.hasNewEmbeddedBook,
    run: async (detail) => { /* 执行动作 */ },
});
```

| 字段 | 类型 | 契约 |
| ---- | ---- | ---- |
| `id` | string | 唯一且稳定。只允许字母、数字、`_` 和 `-`，且必须以字母开头。非法 id、缺少函数或非对象描述符会抛出 `TypeError`。重复注册同一个 id 会记录警告并替换旧描述符，同时保留它在列表中的位置。 |
| `label()` | 函数 → string | 按钮文字。 |
| `description(detail)` | 函数 → string | 对话框中标签旁的一行说明。 |
| `isAvailable(detail)` | 函数 → boolean | 本次替换是否提供该动作。检查过程抛错会记录警告并跳过该动作。 |
| `run(detail)` | 异步函数 | 执行动作。执行抛错会记录警告并显示错误提示，替换流程本身不受影响。 |

规则：

- 按钮按注册顺序排列，第一个可用动作是弹窗的默认项（实心按钮）。
- 只有存在至少一个可用动作时才会弹出对话框。没有全局开关：插件被禁用就不会注册，其动作自然消失，而核心动作始终生效。
- 弹窗最多显示 9 个动作（弹窗 API 的自定义按钮上限），超出部分会被截断并输出控制台警告。
- `label()` 抛错时回退为动作 id；`description()` 抛错会记录警告并显示空说明。取消对话框不会执行任何动作，替换流程照常继续。

### `detail` 对象

| 字段 | 说明 |
| ---- | ---- |
| `characterId` | 被替换角色在 `ctx.characters` 中的下标。 |
| `character` | 替换后的实时角色对象。 |
| `previousCharacter` | 替换前的角色卡克隆，可能为 `null`。 |
| `previousLorebookSnapshot` | 从原主世界书抓取的 `{ avatar, characterName, bookName, entries, capturedAt }`，可能为 `null`。 |
| `previousBookName` | 原来的主世界书名（没有则为 `''`）。 |
| `previousBookExists` | 该世界书是否仍然存在。 |
| `hasNewEmbeddedBook` | 新卡是否带有非空的 `data.character_book`。 |
| `source` | 目前恒为 `'replace_update'`。 |

### 上下文 API

| 函数 | 说明 |
| ---- | ---- |
| `registerCardBindingSlot(descriptor)` | 注册绑定槽位，见第一部分。 |
| `listCardBindingSlots()` | 按注册顺序返回槽位描述符列表。 |
| `registerPostReplaceAction(descriptor)` | 注册动作，见第二部分。 |
| `listPostReplaceActions()` | 按注册顺序返回动作描述符列表。 |
| `importEmbeddedBookForCharacter(characterId)` | 把角色卡的内嵌世界书另存为独立文件并绑定为主世界书。角色不存在或导入入口不可用时抛出异常。 |
| `rebindPreviousPrimaryBook(characterId, bookName)` | 把已有世界书绑定为角色的主世界书。 |
