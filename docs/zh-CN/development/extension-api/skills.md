# Skills

`context.skills.*` 是用于安装、读取、编辑、打包 Skills 的 JavaScript 接口。扩展通过 `Luker.getContext()` 拿到它；CardApp 在自己的 `ctx.skills` 上拿到同样的形状。

Skill 是编排器使用的[知识包](/zh-CN/features/skills/)；这套 API 是支撑 Skill 管理子面板、内嵌编辑器、迭代工作台 17 个 Skill 工具的读写传输层。

::: tip 请先读用户文档
关于概念模型 —— 作用域、可见性策略、嵌入生命周期 —— 从 [Skills 概览](/zh-CN/features/skills/) 开始。本页是 API 参考。
:::

## 入口

```js
const context = Luker.getContext();
const skills = context.skills;

// 或者通过 CardApp ctx（同样形状）:
async function init(ctx) {
  await ctx.skills.list({ scope: 'all' });
}
```

CardApp ctx 接口是底层同一组函数的薄包装 —— 调用签名与返回形状相同（遵循 Luker 的 [API 对等约定](https://github.com/funnycups/Luker/blob/release/CLAUDE.md)）。

## scope 形状

每个 Skill 操作都接受一个 `scope`。三种形状：

```ts
type SkillScope =
  | { kind: 'global' }
  | { kind: 'preset',    apiId: string, name: string }
  | { kind: 'character', characterFile: string }
```

`list()` 还可以传字符串字面值 `'all'`，一次性从所有作用域取。

## 库存

### `list(opts?)`

列出已安装的 Skill 索引条目（不含正文）。

```ts
list(opts?: {
  scope?: SkillScope | 'all'
}): Promise<SkillIndexEntry[]>
```

`SkillIndexEntry`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `scope` | `SkillScope` | 该 Skill 物理所在的作用域。 |
| `name` | `string` | frontmatter 的 `name`。 |
| `description` | `string` | frontmatter 的 `description`。 |
| `license` | `string \| null` | frontmatter 的 `license`（若有）。 |
| `metadata` | `object` | Anthropic 标准的自由格式 metadata。 |
| `installedHash` | `string` | 完整文件树的 sha256。读期间稳定；每次写入都会变。 |
| `fileCount` | `number` | Skill 目录里的文件总数。 |
| `totalBytes` | `number` | 文件大小总和。 |
| `hasScripts` | `boolean` | Skill 携带 `scripts/` 目录时为 true。 |
| `hasBinary` | `boolean` | 任一文件看上去是二进制（前 512 字节有空字节）时为 true。 |
| `installedAt` | `string` | 目录 mtime 的 ISO 时间戳。 |

例子：

```js
const all = await context.skills.list({ scope: 'all' });
console.log(all.map(s => `${s.scope.kind}:${s.name}`));

const globalOnly = await context.skills.list({ scope: { kind: 'global' } });
```

### `get(name, scope?)`

便捷方法：按名字找单个条目（在某作用域内，或任何地方）。

```ts
get(name: string, scope?: SkillScope | 'all'): Promise<SkillIndexEntry | null>
```

搜索范围内没有该名字时返回 `null`。

省略 `scope` 时返回首个匹配 —— 适合用作「这个 Skill 某处存在吗」的检查，但不能替代编排器的后者优先解析。需要确定性查找时传入特定 scope。

## 读取内容

### `readFile(opts)`

读取 Skill 内的单个文件。

```ts
readFile(opts: {
  scope: SkillScope,
  name: string,
  path?: string,        // 缺省 'SKILL.md'
  offset?: number,      // 1-based 行偏移
  limit?: number,       // 行数
}): Promise<{
  content: string,
  totalLines: number,
  truncated: boolean,
}>
```

- `path` 缺省 `SKILL.md`。传 `references/checklist.md` 等子路径以读其它文件。
- `offset` 和 `limit` 按行操作（1-based）。
- 服务端强制 50 KB 响应上限。被截断时 `truncated: true` —— 再调一次带 `offset` 继续。

### `listFiles(opts)`

枚举 Skill 里的每个文件，带 size 和 binary 标记。

```ts
listFiles(opts: {
  scope: SkillScope,
  name: string,
}): Promise<{
  files: Array<{
    path: string,
    size: number,
    isBinary: boolean,
  }>
}>
```

`SKILL.md` 永远在第一位；其余按 `localeCompare` 排序。在不清楚 Skill 里有什么时，先用这个再 `readFile`。

### `search(opts)`

在单个 Skill 的文件内做子串搜索。

```ts
search(opts: {
  scope: SkillScope,
  name: string,
  query: string,
  path?: string,        // 可选的单文件范围；缺省所有文本文件
  limit?: number,
  contextLines?: number,
}): Promise<{
  hits: Array<{
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  }>
}>
```

搜索是大小写不敏感的子串（非正则）。二进制文件被跳过。

## 写入内容

所有写入走磁盘上的 `.staging/` 目录，全部校验通过后原子提交。失败的写入对原文件零影响。

### `writeFile(opts)`

替换整个文件。

```ts
writeFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  content: string,
  expectedSha256?: string,  // 乐观并发控制
}): Promise<{ sha256: string }>
```

如果传了 `expectedSha256` 且与当前文件哈希不匹配，写入以 `409` 冲突失败 —— 适合编辑器式的并发编辑检测。

返回的 `sha256` 是新文件的内容哈希。

### `editFile(opts)`

原地字符串替换。只想改一处时比 `writeFile` 便宜。

```ts
editFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,  // 缺省 false
}): Promise<{
  sha256: string,
  changesApplied: number,
}>
```

- `oldString` 必须出现在文件里（否则抛错）。`replaceAll: false` 时 `oldString` 必须**恰好出现一次**。
- `oldString` 不能为空（服务端拒绝空 `oldString` 以避免歧义匹配）。
- 返回的 `changesApplied` 是 1（或 `replaceAll: true` 时的匹配数）。

### `deleteFile(opts)`

删除 Skill 内的单个文件。`SKILL.md` 不能通过这条路径删 —— 用 `delete(scope, name)` 删除整个 Skill。

```ts
deleteFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
}): Promise<void>
```

## 管理

### `install(opts)`

从 JSON 载荷（内联文件）或存档安装一个 Skill。

```ts
install(opts: {
  scope: SkillScope,
  payload: SkillInstallPayload,
  conflictStrategy?: 'skip' | 'replace',  // 缺省: 冲突抛错
}): Promise<{
  installed: boolean,
  conflict?: 'same' | 'different',
  name: string,
}>
```

`SkillInstallPayload` 为以下两种之一：

```ts
// 内联文件（推荐给纯文本 Skill，≤ 10 文件，每个 ≤ 64 KB）
{
  bundleFormat: 'inline-files-v1',
  name: string,
  files: Array<{ path: string, encoding: 'utf8' | 'base64', content: string }>
}

// base64 编码的 zip（最大可达单 Skill 上限）
{
  bundleFormat: 'archive-base64-v1',
  name: string,
  fileName: string,
  contentBase64: string,
  sha256: string,
}
```

目标作用域存在同名 Skill 时：

- 内容相同（哈希匹配）→ 静默 no-op。
- 内容不同 → 抛错，除非 `conflictStrategy: 'replace'`。`'skip'` 在冲突时 no-op。

### `delete(scope, name)`

```ts
delete(scope: SkillScope, name: string): Promise<void>
```

原子移除 Skill 目录。引用该 Skill 的编排器 profile 仍保留 `skills.visible` 里的旧名 —— 派遣时引用软失败。

### `rename(scope, oldName, newName)`

```ts
rename(scope: SkillScope, oldName: string, newName: string): Promise<void>
```

原子改名目录与 frontmatter `name`。引用不会自动更新。

### `moveScope(name, fromScope, toScope)`

```ts
moveScope(
  name: string,
  fromScope: SkillScope,
  toScope: SkillScope,
): Promise<void>
```

跨作用域原子文件系统 move。编排器引用（只按名字）依然有效。想要覆盖目标，先删目标作用域里的同名 Skill 再 move 即可。

### `importBundled()`

从 `default/skills/global/` 重装所有出厂 Skill，覆盖任何同名本地副本。

```ts
importBundled(): Promise<{
  installed: number,   // 处理的出厂 Skill 总数
  replaced: number,    // 本地存在、被覆盖的
  added: number,       // 本地不存在、新增的
}>
```

::: warning 破坏性
这是 Skill 版的 `git reset --hard` —— 它把每个同名全局 Skill 都覆盖成出厂版本。先备份本地修改。
:::

### `listBundledManifest()`

列出 `default/skills/global/` 下出厂的 Skill，每个都附带导入后会生成的 install 哈希。**浏览出厂** tab 用这个来跟本地安装对比，无需重跑 install。

```ts
listBundledManifest(): Promise<Array<{
  name: string,
  installedHash: string,
  fileCount: number,
  totalBytes: number,
  description: string,
}>>
```

## 传输

这些函数支持通过角色卡和预设跨主机分发 Skill。

### `packForEmbed(opts)`

把一个或多个 Skill 打包成嵌入载荷，可塞进预设或角色卡。

```ts
packForEmbed(opts: {
  scope: SkillScope,
  names: string[],
  mode?: 'inline-files-v1' | 'archive-base64-v1' | 'auto',  // 缺省 'auto'
}): Promise<EmbeddedPayload>
```

`EmbeddedPayload`：

```ts
{
  version: 1,
  items: Array<SkillInstallPayload>
}
```

`mode: 'auto'` 时打包器按每 Skill 自选：小且纯文本的用内联，更大或二进制的用存档。

编排器的嵌入导出钩子会把载荷写入 `preset.extensions.luker.embedded_skills_source`（预设）或 `character.data.extensions.luker.embedded_skills_source`（角色卡），在保存时持久化。

### `previewExtractEmbed(opts)`

预览把嵌入载荷抽取进目标作用域的冲突结果。只读 —— 不改文件系统。

```ts
previewExtractEmbed(opts: {
  payload: EmbeddedPayload,
  targetScope: SkillScope,
}): Promise<{
  items: Array<{
    name: string,
    conflict: 'new' | 'same' | 'different',
  }>
}>
```

Skill 管理的导入对话框用它来渲染每 Skill 的跳过/替换选项。

### `executeExtractEmbed(opts)`

用每 Skill 的冲突解决方案执行抽取。

```ts
executeExtractEmbed(opts: {
  payload: EmbeddedPayload,
  targetScope: SkillScope,
  conflictStrategies?: Record<string, 'skip' | 'replace'>,
}): Promise<{
  installed: string[],   // 已安装的名字
  skipped: string[],     // 跳过的名字（按 conflictStrategies 或 'same'）
  failed: Array<{ name: string, error: string }>,
}>
```

`conflictStrategies` 按 Skill 名为 key；缺失条目缺省按 `'different'` 抛错。`'same'` 条目永远静默 no-op。

### `importFromUrl(opts)`

从 HTTPS URL 拉取单个 `SKILL.md` 并作为单文件 Skill 安装。

```ts
importFromUrl(opts: {
  url: string,         // 必须是 https://
  targetScope: SkillScope,
}): Promise<{
  name: string,
  conflict: 'new' | 'same' | 'different',
}>
```

多文件 Skill 不能通过 URL 导入 —— 用 `install()` 配 `archive-base64-v1` 载荷（或 Skill 管理的**从文件导入**流程）。

## 错误处理

所有方法在服务端错误时抛错。抛出的 `Error` 携带：

| 属性 | 类型 | 说明 |
|---|---|---|
| `.message` | `string` | 服务端错误信息。 |
| `.status` | `number` | HTTP 状态码（如 `404`、`409`、`400`）。 |
| `.body` | `object` | 解析后的响应体（通常 `{ error, code, ... }`）。 |

常见形状：

```js
try {
  await context.skills.editFile({ ... });
} catch (err) {
  if (err.status === 409) {
    // SHA 不匹配 —— 文件在我们读之后被改过。重载再试。
  } else if (err.status === 404) {
    // 找不到 Skill 或文件。
  } else {
    throw err;
  }
}
```

## CardApp 对等

CardApp 的 `ctx.skills` 接口与 `context.skills.*` 1:1 镜像 —— 签名相同、返回形状相同。CardApp 可以套用同样的范式：

```js
async function init(ctx) {
  // 列出对任何人可见的 Skill（CardApp 不受编排器
  // per-agent 可见性过滤 —— 它们看到的是原始库存）。
  const skills = await ctx.skills.list({ scope: 'all' });

  // 读一个 Skill 的正文
  const { content } = await ctx.skills.readFile({
    scope: { kind: 'character', characterFile: ctx.characterFile },
    name: 'card-voice-rules',
  });

  ctx.setVariable('voice_rules', content);
}
```

`ctx.skills` 包装层有意保持很薄 —— 永远不会比 `getContext().skills` 富。新的 API 添加会同时落在两处。

## 相关

- [Skills 概览](/zh-CN/features/skills/) —— 什么是 Skill、三种作用域
- [创作 Skill](/zh-CN/features/skills/authoring) —— frontmatter + 正文约定
- [Skill 管理](/zh-CN/features/skills/management) —— 同等操作的 UI 接口
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 运行时如何按 `skills.visible` / `deny` 过滤
- [扩展 API 概览](/zh-CN/development/extension-api/) —— `context.*` 上的其它命名空间
