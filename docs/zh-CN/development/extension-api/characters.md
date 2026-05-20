# 角色卡

读取角色卡、修改卡片字段、导入角色、管理标签的相关 API。`context.characters` 数组用 Proxy 包装，读写语义有所不同——参见下文 [Proxy 语义](#proxy-语义)。

## 读取角色

### context.characters

```ts
context.characters: Character[]
```

所有已加载角色对象的数组。用 Proxy 包装，同时支持 V2（`character.data.*`）和旧版根级字段访问——参见 [Proxy 语义](#proxy-语义)。

### context.characterId

```ts
context.characterId: number | undefined
```

当前选中角色在 `context.characters` 中的索引。无角色被选中时（例如群聊中）为 `undefined`。

### getOneCharacter

```ts
getOneCharacter(avatarUrl: string): Promise<void>
```

从服务器重新拉取单个角色，并替换 `context.characters` 中的对应槽位（按 `avatar` 字段匹配）。在服务端发生变更后用于刷新内存状态。

### getCharacters

```ts
getCharacters(): Promise<void>
```

重新拉取完整角色列表。会触发 UI 重新渲染。当服务器报告 payload 过大时，弹出警告 toast。

### getOneCharacter vs getCharacters

| 用途 | 何时使用 |
|------|------|
| `getOneCharacter(avatar)` | 服务端修改了某张特定卡片，只刷新这一张 |
| `getCharacters()` | 发生了批量导入 / 删除，全部刷新 |

### getCharacterCardFields

```ts
getCharacterCardFields(options?: { chid?: number }): {
    system: string,
    mesExamples: string,
    description: string,
    personality: string,
    persona: string,
    scenario: string,
    jailbreak: string,
    version: string,
    charDepthPrompt: string,
    creatorNotes: string,
    firstMessage: string,
    alternateGreetings: string[],
}
```

返回经过宏替换和 persona 注入后解析好的卡片字段。省略 `chid` 时使用当前角色。当你需要为提示词组装准备字段时，请用这个函数而不是直接读 `character.data.*`。

### getCharacterSource

```ts
getCharacterSource(chId?: number | string): string
```

返回角色卡的规范源 URL（chub、pygmalion、github、perchance、risuai 或 `data.extensions.source_url`）。无源信息时返回 `''`。

### getCharaFilename

```ts
getCharaFilename(
    chid?: number | string | null,
    options?: { manualAvatarKey?: string },
): string | null
```

返回角色头像文件名（**不带扩展名**）。省略 `chid` 时回退到当前角色。当你只有头像 key 字符串时（例如来自 sidecar 条目），传入 `manualAvatarKey`。无法解析头像时返回 `null`。

```js
const ctx = Luker.getContext();
const filename = ctx.getCharaFilename();  // 例如 'tavernkeeper'
```

### getThumbnailUrl

```ts
getThumbnailUrl(type: string, file: string, t?: boolean): string
```

构建头像 / 背景 / 世界书的缩略图端点 URL。传 `t: true` 会附加一个用于打破缓存的时间戳。

## 选中与加载角色

### selectCharacterById

```ts
selectCharacterById(id: number, options?: { switchMenu?: boolean }): Promise<void>
```

切换活动角色。以下情况会静默退出：
- 角色不存在
- 当前正在保存聊天（弹出 toast 提示）

`switchMenu` 默认 `true`，重新选中同一角色时会打开角色编辑面板。

### unshallowCharacter

```ts
unshallowCharacter(characterId: number | string): Promise<void>
```

为以浅形式（仅 avatar + 基础元数据）返回的角色加载完整记录。角色已是完整状态时为 no-op。如果你从列表端点拿到的角色，在读取 `description`、`mes_example` 等大字段前必须先调用此函数。

### unshallowGroupMembers

```ts
unshallowGroupMembers(groupId: string): Promise<void>
```

群组的批量版本——对群组中每个成员调用 `unshallowCharacter`。

## 写入卡片字段

### writeExtensionField

```ts
writeExtensionField(
    characterId: number | string,
    key: string,
    value: any,
): Promise<void>
```

写入角色卡的 `data.extensions[key]` 并持久化。

**替换语义。** 完整的 `value` 会成为磁盘上新的 `data.extensions[key]`。先前磁盘值中存在的兄弟子键**不会**被保留——希望做局部更新的调用方必须自行读取旧值、展开并叠加变更。`data.extensions.*` 下的其他扩展 key（其他插件的数据）则永远不会被触碰。

传 `value: context.constants.unset`（即 `UNSET_VALUE` 哨兵值）可彻底删除该 key。传裸 `null` 写入的是字面量 `null`（key 仍然保留）。

```js
const ctx = Luker.getContext();

// 把 data.extensions.my_plugin_state 整体替换为 { level: 5 }。
// my_plugin_state 之前的任何其他子键都会被清除。
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { level: 5 });

// 局部更新：读取旧值、叠加、写回。
const prev = ctx.characters[ctx.characterId]?.data?.extensions?.my_plugin_state ?? {};
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { ...prev, level: 5 });

// 彻底删除该 key。
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', ctx.constants.unset);
```

这是写插件扩展字段的**安全路径**——它完全绕过 `context.characters` Proxy。

### writeExtensionFieldBulk

```ts
writeExtensionFieldBulk(
    avatars: string[] | null,
    key: string,
    value: any,
    options?: { filterPath?: string },
): Promise<{ updated: string[], skipped: string[], failed: string[] }>
```

跨多个角色的单次批量写入，每张卡都套用与 `writeExtensionField` 相同的替换语义。`avatars: null` 或 `[]` 表示作用于所有角色。当 `value` 是 `unset` 哨兵且未提供 `filterPath` 时，自动将 `filterPath` 默认设为 `data.extensions.<key>`，从而跳过没有该字段的卡片。

### createCharacterData

```ts
context.createCharacterData: NewCharacterDraft
```

承载正在进行的「创建新角色」表单的可变 buffer。`context.menuType === 'create'` 时可直接读写——例如 [`getCharaAuxWorlds`](/zh-CN/development/extension-api/world-info#getcharaauxworlds) 就是从这里读取 `extra_books`。

### updateCharacterData

```ts
updateCharacterData(
    charId: number | string,
    patch: Record<string, any>,
    options?: { persist?: boolean, immediate?: boolean }
): Promise<void>
```

更新某张卡 `data` 对象上的一个或多个**表单层**字段，**不依赖**角色编辑器弹窗打开。patch 形态是 `character.data` 的 dot-path 映射，用于表单层字段（`description`、`name`、`personality`……）。中间对象会自动按需创建。

```js
const ctx = Luker.getContext();
// 更新一个顶层字段
await ctx.updateCharacterData(ctx.characterId, { description: '新的描述。' });
```

**限制：** 以 `extensions.` 开头的 dot-path（或裸 key `extensions`）会被**拒绝**——扩展数据请改用 `writeExtensionField`，它对插件数据块采用正确的替换语义。

```js
// 抛错——请改用 writeExtensionField。
await ctx.updateCharacterData(ctx.characterId, { 'extensions.world': 'my_book' });
```

跟现有的 `saveCharacterDebounced` / 表单路径互补 — 弹窗打开时仍走表单（那时表单是 source of truth）。`updateCharacterData` 是面向 AI 工具、slash command、以及其他可能在编辑器关闭时运行的程序化调用方的数据驱动替代路径。

写入 in-memory 后会触发 [`event_types.CHARACTER_FIELDS_UPDATED`](#character_fields_updated-event)，携带 `{ charId, keys }`，让 view （打开的弹窗、CardApp UI） 从权威 data sync。

| 选项 | 默认 | 含义 |
|---|---|---|
| `persist` | `true` | 是否调度一次保存。需要做"另一调用方稍后会保存"的暂时写入时传 `false`。 |
| `immediate` | `false` | 立刻 await 保存，不走 debounce。后续代码需要文件已落盘时使用。 |

### persistCharacterData

```ts
persistCharacterData(charId: number | string): Promise<void>
```

把某张卡当前的 in-memory `data` 序列化成 `/api/characters/edit` 期望的 multipart shape 后 POST 落盘。表单**不参与** — 只看 `characters[charId]`。服务器会把 payload 与磁盘上现有的 JSON 深合并，这对表单层字段是正确行为（保留了表单从未触及的未知扩展数据）。

HTTP 失败时抛错。扩展数据**不会**走这条路径——它有自己的 `/api/characters/merge-attributes` 路径，采用替换语义（[`writeExtensionField`](#writeextensionfield)）。

绝大多数调用方应该用 `updateCharacterData`（它会替你调度这个）。只有当你已经亲自 mutate 过 in-memory 对象、想 flush 时才直接调用。

### persistCharacterDataDebounced

```ts
persistCharacterDataDebounced(charId: number | string): void
```

在标准 save-edit 超时上调度一次防抖的 `persistCharacterData(charId)` 调用（按 character 各自调度 — 同时写两张不同的卡不会被合并成单次错误目标的保存）。窗口内的后续调用会被合并。

### `character_fields_updated` event

`updateCharacterData` mutate `characters[charId].data` 之后、持久化完成之前触发。监听器接收 `{ charId, keys }`，`keys` 是 patch 里的 dot-path 数组。用它来 sync view（弹窗表单、CardApp 面板）而无需轮询。

```js
const ctx = Luker.getContext();
ctx.eventSource.on(ctx.eventTypes.CHARACTER_FIELDS_UPDATED, ({ charId, keys }) => {
    if (charId === ctx.characterId && keys.includes('description')) {
        // 从 characters[charId].data.description 刷新你的 UI
    }
});
```

## 标签

### context.tags

```ts
context.tags: Tag[]
```

所有标签定义的主列表：`{ id, name, folder?, color?, color2?, create_date }`。

### context.tagMap

```ts
context.tagMap: Record<string, string[] | null>
```

将每个角色头像（或群组 id）映射到其分配的标签 id。

### importTags

```ts
importTags(
    character: Character,
    options?: { importSetting?: TagImportSetting | null },
): Promise<boolean>
```

把角色声明的标签（`character.tags[]`）导入到主标签列表并分配。每个角色最多导入 50 个标签，防止恶意卡片。至少添加了一个标签时返回 `true`。

## 导入 / 导出

### importFromExternalUrl

```ts
importFromExternalUrl(
    url: string,
    options?: { preserveFileName?: string | null },
): Promise<void>
```

从外部 URL 或内容 UUID 导入角色或世界书。服务器检查响应的 `Content-Type` 并路由到对应导入路径：

- `'character'` → 进入 `processDroppedFiles`
- `'lorebook'` → 进入 `importWorldInfo`
- 其他 → 弹出未知类型 toast

`preserveFileName` 在 dispatch 步骤中覆盖响应的文件名。

## 按角色的旁挂状态

如果你的数据应该跟着角色跨聊天保留、又**不应该**修改角色卡 JSON，请使用按角色的旁挂状态。这与扩展字段（[`writeExtensionField`](#writeextensionfield)，存在卡片本身里面）不同。

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

读取指定角色头像和命名空间下的旁挂状态。无数据时返回 `null`。

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

写入旁挂状态。传 `data: null` 删除该命名空间的旁挂条目。

```js
const ctx = Luker.getContext();
const character = ctx.characters[ctx.characterId];

await ctx.setCharacterState(character.avatar, 'my-plugin', {
    initialized: true,
    counter: 1,
});

const state = await ctx.getCharacterState(character.avatar, 'my-plugin');
```

::: tip 旁挂 vs 扩展字段
- 扩展字段（`writeExtensionField` → `data.extensions.<key>`）是卡片的一部分。会随卡片一起导出，对拿到卡片的任何人可见。
- 旁挂（`get/setCharacterState`）是放在卡片旁边的独立文件，不会随卡片导出。
:::

## Proxy 语义

`context.characters` 是 Proxy，平滑了 V2 角色格式（文本字段位于 `character.data.*` 下）和旧版根级形态（`character.name`、`character.description` 等）。理解它很重要，因为读写行为不同。

### 读取

任意路径都能读——Proxy 会回退到有数据的那一个：

```js
const character = ctx.characters[ctx.characterId];

character.name              // OK——data.name 存在时穿透到那里
character.data.name         // OK——直接走 V2
character.data.extensions.foo  // OK——同样被代理
```

`Object.keys()`、`for...in`、解构展开也能看到旧版 key，因此原本写 `{ ...character }` 的代码继续生效。

### 写入

写旧版根级字段**可以工作**，但会触发弃用警告 + 一次性 toast：

```js
character.name = 'Bob';        // 警告；镜像到 data.name 并触发 toast
character.data.name = 'Bob';   // 推荐；无警告
```

弃用范围正好覆盖：

| 旧版字段 | 规范路径 |
|------|------|
| `name` | `data.name` |
| `description` | `data.description` |
| `personality` | `data.personality` |
| `scenario` | `data.scenario` |
| `first_mes` | `data.first_mes` |
| `mes_example` | `data.mes_example` |
| `creatorcomment` | `data.creator_notes` |
| `tags` | `data.tags` |
| `talkativeness` | `data.extensions.talkativeness` |
| `fav` | `data.extensions.fav` |

### 镜像规则

通过规范路径写入会自动镜像回旧版字段，反之亦然：

```js
character.data.name = 'Alice';
character.name === 'Alice';         // true——自动镜像

character.data.extensions.fav = true;
character.fav === true;             // true——自动镜像
```

写入时会进行字段归一化：
- 文本字段 → 强制转字符串
- `tags` → 修剪后非空字符串数组（也接受逗号分隔的字符串）
- `talkativeness` → 有限数字，非数值输入默认为 `0.5`
- `fav` → 布尔值，识别字符串 `'true'` / `'false'`

### writeExtensionField 绕过 Proxy

`writeExtensionField` 直接写底层 `characters` 的活引用，因此即使目标是旧版字段也不会触发弃用 toast。任何持久化的扩展数据都应优先用它。

### 实战要点

- 读取任何字段，根级或嵌套——都没问题。
- 写**表单层**字段——用 `updateCharacterData`（或者，当你直接 mutate `data.*` 时，紧跟一个 `persistCharacterData`）。
- 写**扩展数据**——用 `writeExtensionField` / `writeExtensionFieldBulk`。替换语义：调用方完整控制 `data.extensions.<key>` 的值；兄弟子键不会被保留。
