# 世界书

读取、写入、扫描世界书（lorebook）条目的相关 API。所有函数均通过 `Luker.getContext()` 暴露；原始 HTTP 路由参见[底层端点](/zh-CN/development/extension-api/low-level-endpoints)。

## 读取世界书

### loadWorldInfo

```ts
loadWorldInfo(name: string): Promise<WorldInfoData | null>
```

按名称读取单个世界书文件。名称查找忽略大小写和重音符。无匹配文件时返回 `null`。内部带缓存——重复读取同一文件直接走内存。

```js
const ctx = Luker.getContext();
const book = await ctx.loadWorldInfo('My Lorebook');
console.log(Object.keys(book.entries).length);
```

### loadWorldInfoBatch

```ts
loadWorldInfoBatch(names: string[]): Promise<Map<string, WorldInfoData | null>>
```

一次 HTTP 往返读取多个世界书文件。返回以解析后名称为键的 `Map`；不存在的条目映射为 `null`。已缓存的文件和 in-flight 请求会自动合并。

```js
const books = await ctx.loadWorldInfoBatch(['Book A', 'Book B']);
for (const [name, data] of books) {
    if (data) console.log(name, Object.keys(data.entries).length);
}
```

### getWorldInfoNames

```ts
getWorldInfoNames(): string[]
```

返回编辑器已知的所有世界书文件名的快照副本。可用于填充 UI 下拉框。

### getWorldInfoPrompt

```ts
getWorldInfoPrompt(
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData: WIGlobalScanData,
): Promise<WIPromptResult>
```

底层扫描器，针对给定的聊天切片产出世界书 prompt 片段。大多数插件应优先使用 [`resolveWorldInfoForMessages`](/zh-CN/development/extension-api/presets-and-prompts#resolveworldinfoformessages)——它在此之上封装了归一化和激活后钩子。

`WIPromptResult` 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `worldInfoString` | `string` | `before` 与 `after` 用换行连接 |
| `worldInfoBeforeEntries` | `string[]` | 注入到聊天前的条目 |
| `worldInfoAfterEntries` | `string[]` | 注入到聊天后的条目 |
| `worldInfoExamples` | `Array<{position, content}>` | 对话示例条目 |
| `worldInfoDepth` | `Array<{depth, role, entries}>` | depth 注入条目 |
| `anBefore` / `anAfter` | `string[]` | Author's note 注入 |
| `outletEntries` | `Record<string, string[]>` | 自定义 outlet 内容 |

当 `isDryRun` 为 `false` 时，会触发 `event_types.WORLD_INFO_ACTIVATED` 事件，携带激活的条目。

## 写入世界书

### saveWorldInfo

```ts
saveWorldInfo(
    name: string,
    data: WorldInfoData,
    immediately?: boolean,
    options?: object,
): Promise<void>
```

将世界书文件持久化到磁盘。缓存同步更新；网络写入默认走 debounce 队列。

| 参数 | 说明 |
|------|------|
| `name` | 文件名（不含 `.json` 扩展名） |
| `data` | 完整世界书对象（`{ entries: Record<number, WIEntry> }`） |
| `immediately` | 为 `true` 时等待真正写入完成而非 debounce |

`name` 或 `data` 为 falsy 时直接返回。

### updateWorldInfoList

```ts
updateWorldInfoList(): Promise<void>
```

从服务器刷新全局 `world_names` 列表。在编辑器 UI 之外创建、删除、重命名文件后调用。

### createWorldBook

```ts
createWorldBook(name: string, options?: { interactive?: boolean }): Promise<boolean>
```

创建一个新的空世界书文件。成功返回 `true`，失败返回 `false`（例如 `interactive` 为 false 时遇到重名）。`interactive: false`（默认）会跳过重名确认弹窗，适合程序化创建。新建文件没有任何条目，通过 [`saveWorldInfo`](#saveworldinfo) 或编辑器写入条目。

### importEmbeddedWorldInfo

```ts
importEmbeddedWorldInfo(skipPopup?: boolean): Promise<void>
```

把 V2/V3 PNG 卡内嵌的 `data.character_book` 导入为独立的世界书文件并绑定为该角色的 primary world。要导入哪张卡通过 `#import_character_info` 元素的 `chid` data 属性读取（角色编辑器在打开含内嵌书的卡时会设置这个值）。`skipPopup: true` 用来跳过确认弹窗直接导入，适合已经获取过明确确认的工具调用。导入完成后，`characters[chid].data.extensions.world` 指向新文件，内嵌书不再被提示重新导入。

### charUpdatePrimaryWorld

```ts
charUpdatePrimaryWorld(name: string): Promise<void>
```

通过名字绑定角色的主世界书（传 `''` 解绑）。走角色编辑器的保存路径，因此需要当前有活跃的角色上下文。

### getCharacterEmbeddedWorld

```ts
getCharacterEmbeddedWorld(charId: number | string): {
    present: boolean,
    name: string | null,
    entryCount: number,
    bound: boolean,
}
```

只读地查询某张卡的 V2/V3 内嵌 `data.character_book` 状态：
- `present` — 卡是否携带内嵌书。
- `name` — 内嵌书的 `name` 字段。
- `entryCount` — 内嵌书包含的条目数。
- `bound` — 卡是否已经绑定了一个真实的世界书文件（即 `data.extensions.world` 解析得到一个已知的世界书）。`present && !bound` 表示内嵌书还没通过 `importEmbeddedWorldInfo` 导入。`present && bound` 表示内嵌书只是绑定世界的过期镜像（导出时留下的良性副产物），运行时应忽略。

### reloadWorldInfoEditor

```ts
reloadWorldInfoEditor(file: string, loadIfNotSelected?: boolean): void
```

重新渲染 `file` 对应的世界书编辑器。当 `file` 不是当前打开的文件时默认无操作；将 `loadIfNotSelected` 设为 `true` 可切换到该文件。

## 激活扫描

### simulateWorldInfoActivation

```ts
simulateWorldInfoActivation(request: {
    coreChat?: ChatMessage[],
    maxContext?: number,
    dryRun?: boolean,
    type?: string,
    chatForWI?: string[],
    includeNames?: boolean,
    globalScanData?: WIGlobalScanData,
}): Promise<WIPromptResult & {
    chatForWI: string[],
    maxContext: number,
    globalScanData: WIGlobalScanData,
}>
```

针对提供的消息执行一次世界书激活扫描，返回激活结果。这是 [`resolveWorldInfoForMessages`](/zh-CN/development/extension-api/presets-and-prompts#resolveworldinfoformessages) 背后的原语；只在需要更精细地控制扫描输入时直接调用。

| 参数 | 说明 |
|------|------|
| `coreChat` | 用于扫描的消息列表（`{ name, mes, is_user, is_system }`） |
| `maxContext` | token 预算；省略或 `<= 0` 时回退到 `getMaxPromptTokens()` |
| `dryRun` | 为 `true` 时抑制 `WORLD_INFO_ACTIVATED` 事件 |
| `type` | 生成触发标签（`'normal'`、`'quiet'`、`'regenerate'` 等） |
| `chatForWI` | 预先构建的扫描输入；提供时会跳过 `buildWorldInfoChatInput` |
| `includeNames` | 是否在每条扫描行前加上 `name:` |
| `globalScanData` | 角色卡派生扫描字段的覆盖值 |

返回对象会回显实际使用的 `chatForWI`、`maxContext`、`globalScanData`，便于调用方检视解析后的扫描输入。

### buildWorldInfoChatInput

```ts
buildWorldInfoChatInput(messages: ChatMessage[], includeNames?: boolean): string[]
```

构建 WI 扫描器期望的**反转**扫描字符串数组。`includeNames` 为真时每行格式为 `"name: mes"`，否则只是 `mes`。当你想给 `simulateWorldInfoActivation` 喂一份预格式化的切片时有用。

### buildWorldInfoGlobalScanData

```ts
buildWorldInfoGlobalScanData(type: string, overrides?: Partial<WIGlobalScanData>): WIGlobalScanData
```

为当前角色构建角色卡派生的扫描字段（`personaDescription`、`characterDescription`、`characterPersonality`、`characterDepthPrompt`、`scenario`、`creatorNotes`、`trigger`）。传入 `overrides` 可在不重建整个对象的情况下替换单个字段。

### getActiveWorldInfoPromptFields

```ts
getActiveWorldInfoPromptFields(): {
    worldInfoBeforeEntries: string[],
    worldInfoAfterEntries: string[],
}
```

返回最近一次实时生成流水线中捕获的世界书 `before`/`after` 片段。无活动聊天或快照属于其他聊天时返回空数组。当你想读取上次注入的内容、又不想重跑一次扫描时使用。

## 角色辅助世界书

角色卡可以在主 `world` 字段之外声明额外的世界书绑定——例如 CardApp 可以为角色内置工具绑定额外的参考书。

### getCharaAuxWorlds

```ts
getCharaAuxWorlds(charaFilename: string): string[]
```

返回绑定到角色的辅助世界书名称去重列表。解析规则：

- 角色创建期间（`menu_type === 'create'`），从 in-flight 的新角色缓冲区读取。
- 否则从持久化的 `world_info.charLore` 中匹配 `charaFilename` 的条目读取。

`charaFilename` 为 falsy 或没有绑定时返回 `[]`。配合 [`getCharaFilename`](/zh-CN/development/extension-api/characters#getcharafilename) 解析当前角色：

```js
const ctx = Luker.getContext();
const auxBooks = ctx.getCharaAuxWorlds(ctx.getCharaFilename());
const datas = await ctx.loadWorldInfoBatch(auxBooks);
```

## 格式转换

### convertCharacterBook

```ts
convertCharacterBook(characterBook: V2CharacterBook): {
    entries: Record<number, WIEntry>,
    originalData: V2CharacterBook,
}
```

把 V2 角色卡的 `character_book` 负载转换成内部世界书结构。导入角色卡或将 V2 lore 投影到可编辑条目时使用。`originalData` 保留以便往返序列化。

## 条目级辅助函数

用于程序化创建条目和同步 UI。全部挂在 `context.worldInfoEntry` 下。

### worldInfoEntry.template

```ts
context.worldInfoEntry.template: WIEntry
```

条目的标准默认结构（占位 `uid: 0`、空 key 列表、`position: 0` 等）。批量构造条目时用「克隆—修改」方式使用,这样未来 schema 新增字段会自动跟上。

```js
const ctx = Luker.getContext();
const fresh = { ...ctx.worldInfoEntry.template, uid: newUid, key: ['npc:Bob'], content: '一位面包师。' };
```

### worldInfoEntry.create

```ts
context.worldInfoEntry.create(name: string, data: WorldInfoData): WIEntry
```

在给定的世界书 `data` 中创建并插入一条新条目,返回插入的条目对象。会分配下一个空闲 `uid`,填默认值,并就地修改 `data.entries`。之后用 `saveWorldInfo()` 持久化。

### worldInfoEntry.delete

```ts
context.worldInfoEntry.delete(data: WorldInfoData, uid: number, options?: { silent?: boolean }): Promise<boolean>
```

从 `data.entries` 中移除指定 `uid` 的条目,返回删除是否成功。传 `silent: true` 跳过给用户的确认 toast——批量程序化编辑时有用。之后用 `saveWorldInfo()` 持久化。

### worldInfoEntry.setButtonClass

```ts
context.worldInfoEntry.setButtonClass(chid: number | string, forceValue?: boolean): void
```

更新角色卡 UI 上「世界书已绑定」状态徽章的样式类。传 `forceValue` 可强制覆盖计算出来的绑定状态。程序化改完绑定（例如 `charUpdatePrimaryWorld`）后调用。

### worldInfoEntry.setGlobalSelection

```ts
context.worldInfoEntry.setGlobalSelection(
    worldInfoName: string,
    selected: boolean,
    options?: object,
): Promise<void>
```

把某本世界书加入或移出全局激活列表（即世界书面板顶部的多选）。立即持久化;UI 在下次 selector 刷新时同步。

### worldInfoEntry.getSorted

```ts
context.worldInfoEntry.getSorted(): Promise<WIEntry[]>
```

返回当前所有激活世界书（按聊天 + 全局 + 角色主书 + 角色辅助书）里的全部条目,预先合并并按注入顺序排好。需要拿到「扫描器当下看到的视图」时用——例如插件想列「现在哪些条目有资格触发」而不想重新跑一遍完整激活流程。

## 聊天绑定的世界书

按聊天的世界书绑定存在 `chat_metadata.world_info` 中,跟随聊天走。用 `context.chatWorldInfo` 查看和修改。

### chatWorldInfo.getNames

```ts
context.chatWorldInfo.getNames(
    metadata?: object,
    options?: { resolveNames?: boolean, onlyExisting?: boolean },
): string[]
```

返回绑定到该聊天的世界书名称列表。默认走当前聊天的 metadata。`resolveNames: true`（默认）把 uid 形式的条目映射回文件名;`onlyExisting: true`（默认）丢弃文件已不存在的名称。

### chatWorldInfo.setSelection

```ts
context.chatWorldInfo.setSelection(names: string[], metadata?: object): boolean
```

把聊天绑定的世界书选择替换为 `names`。就地修改 metadata,返回选择是否实际变了。调用者通过 `saveMetadata()` / `saveMetadataDebounced()` 持久化。

### chatWorldInfo.globalSelection

```ts
context.chatWorldInfo.globalSelection: string[]
```

用户全局激活世界书列表（在每个聊天都生效的那些）的只读实时快照。要修改请用 `worldInfoEntry.setGlobalSelection`——直接写入不会持久化。

## 位置常量

### context.constants.wiAnchor

```ts
context.constants.wiAnchor: { before, after }
```

样例对话条目锚点侧的数值枚举。构造或对比 `worldInfoExamples[i].position` 时使用。

### context.constants.wiPosition

```ts
context.constants.wiPosition: {
    before, after, ANTop, ANBottom, atDepth, EMTop, EMBottom, outlet,
}
```

条目级 `position` 值的数值枚举。构造条目或按注入槽过滤时使用。

```js
const ctx = Luker.getContext();
const entry = {
    ...ctx.worldInfoEntry.template,
    position: ctx.constants.wiPosition.before,
};
```

## 实战模式

### 插件读取并编辑一个世界书

```js
const ctx = Luker.getContext();

const book = await ctx.loadWorldInfo('Setting Bible');
if (!book) {
    console.warn('Lorebook not found');
    return;
}

const newUid = Math.max(0, ...Object.keys(book.entries).map(Number)) + 1;
book.entries[newUid] = {
    uid: newUid,
    key: ['npc:Tavernkeeper'],
    keysecondary: [],
    content: 'A burly man with a scar across his cheek.',
    comment: 'Auto-added by my-plugin',
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    probability: 100,
    useProbability: true,
};

await ctx.saveWorldInfo('Setting Bible', book);
ctx.reloadWorldInfoEditor('Setting Bible', true);
```

### 插件扫描 WI 而不影响主聊天

```js
const wi = await ctx.simulateWorldInfoActivation({
    coreChat: [
        { name: 'User', mes: 'Tell me about the tavernkeeper.', is_user: true },
    ],
    dryRun: true,
});

console.log(wi.worldInfoBeforeEntries);
```

如果想得到能直接传给 `buildPresetAwarePromptMessages` 的结果，请改用 [`resolveWorldInfoForMessages`](/zh-CN/development/extension-api/presets-and-prompts#resolveworldinfoformessages)。
