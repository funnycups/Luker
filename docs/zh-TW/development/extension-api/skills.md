# 技能

`context.skills.*` 是用於安裝、讀取、編輯、打包技能的 JavaScript 介面。擴充透過 `Luker.getContext()` 拿到它；CardApp 在自己的 `ctx.skills` 上拿到同樣的形狀。

技能是編排器使用的[知識包](/zh-TW/features/skills/)；這套 API 是支撐技能管理子面板、內嵌編輯器、迭代工作台 17 個技能工具的讀寫傳輸層。

::: tip 請先讀使用者文件
關於概念模型 —— 作用域、可見性策略、嵌入生命週期 —— 從 [技能概覽](/zh-TW/features/skills/) 開始。本頁是 API 參考。
:::

## 入口

```js
const context = Luker.getContext();
const skills = context.skills;

// 或者透過 CardApp ctx（同樣形狀）:
async function init(ctx) {
  await ctx.skills.list({ scope: 'all' });
}
```

CardApp ctx 介面是底層同一組函式的薄包裝 —— 呼叫簽名與返回形狀相同（遵循 Luker 的 [API 對等約定](https://github.com/funnycups/Luker/blob/release/CLAUDE.md)）。

## scope 形狀

每個技能操作都接受一個 `scope`。三種形狀：

```ts
type SkillScope =
  | { kind: 'global' }
  | { kind: 'preset',    apiId: string, name: string }
  | { kind: 'character', characterFile: string }
```

`list()` 還可以傳字串字面值 `'all'`，一次性從所有作用域取。

## 庫存

### `list(opts?)`

列出已安裝的技能索引條目（不含正文）。

```ts
list(opts?: {
  scope?: SkillScope | 'all'
}): Promise<SkillIndexEntry[]>
```

`SkillIndexEntry`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `scope` | `SkillScope` | 該技能物理所在的作用域。 |
| `name` | `string` | frontmatter 的 `name`。 |
| `description` | `string` | frontmatter 的 `description`。 |
| `license` | `string \| null` | frontmatter 的 `license`（若有）。 |
| `metadata` | `object` | Anthropic 標準的自由格式 metadata。 |
| `installedHash` | `string` | 完整檔案樹的 sha256。讀期間穩定；每次寫入都會變。 |
| `fileCount` | `number` | 技能目錄裡的檔案總數。 |
| `totalBytes` | `number` | 檔案大小總和。 |
| `hasScripts` | `boolean` | 技能攜帶 `scripts/` 目錄時為 true。 |
| `hasBinary` | `boolean` | 任一檔案看上去是二進位（前 512 位元組有空位元組）時為 true。 |
| `installedAt` | `string` | 目錄 mtime 的 ISO 時間戳。 |

例子：

```js
const all = await context.skills.list({ scope: 'all' });
console.log(all.map(s => `${s.scope.kind}:${s.name}`));

const globalOnly = await context.skills.list({ scope: { kind: 'global' } });
```

### `get(name, scope?)`

便捷方法：按名字找單個條目（在某作用域內，或任何地方）。

```ts
get(name: string, scope?: SkillScope | 'all'): Promise<SkillIndexEntry | null>
```

搜尋範圍內沒有該名字時返回 `null`。

省略 `scope` 時返回首個匹配 —— 適合用作「這個技能某處存在嗎」的檢查，但不能替代編排器的後者優先解析。需要確定性查找時傳入特定 scope。

## 讀取內容

### `readFile(opts)`

讀取技能內的單個檔案。

```ts
readFile(opts: {
  scope: SkillScope,
  name: string,
  path?: string,        // 預設 'SKILL.md'
  offset?: number,      // 1-based 行偏移
  limit?: number,       // 行數
}): Promise<{
  content: string,
  totalLines: number,
  truncated: boolean,
}>
```

- `path` 預設 `SKILL.md`。傳 `references/checklist.md` 等子路徑以讀其它檔案。
- `offset` 和 `limit` 按行操作（1-based）。
- 伺服器強制 50 KB 響應上限。被截斷時 `truncated: true` —— 再呼叫一次帶 `offset` 繼續。

### `listFiles(opts)`

列舉技能裡的每個檔案，帶 size 和 binary 標記。

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

`SKILL.md` 永遠在第一位；其餘按 `localeCompare` 排序。在不清楚技能裡有什麼時，先用這個再 `readFile`。

### `search(opts)`

在單個技能的檔案內做子字串搜尋。

```ts
search(opts: {
  scope: SkillScope,
  name: string,
  query: string,
  path?: string,        // 可選的單檔案範圍；預設所有文字檔案
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

搜尋是大小寫不敏感的子字串（非正規表示式）。二進位檔案被跳過。

## 寫入內容

所有寫入走磁碟上的 `.staging/` 目錄，全部校驗通過後原子提交。失敗的寫入對原檔案零影響。

### `writeFile(opts)`

替換整個檔案。

```ts
writeFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  content: string,
  expectedSha256?: string,  // 樂觀並發控制
}): Promise<{ sha256: string }>
```

如果傳了 `expectedSha256` 且與當前檔案雜湊不匹配，寫入以 `409` 衝突失敗 —— 適合編輯器式的並發編輯偵測。

返回的 `sha256` 是新檔案的內容雜湊。

### `editFile(opts)`

原地字串替換。只想改一處時比 `writeFile` 便宜。

```ts
editFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,  // 預設 false
}): Promise<{
  sha256: string,
  changesApplied: number,
}>
```

- `oldString` 必須出現在檔案裡（否則拋錯）。`replaceAll: false` 時 `oldString` 必須**恰好出現一次**。
- `oldString` 不能為空（伺服器拒絕空 `oldString` 以避免歧義匹配）。
- 返回的 `changesApplied` 是 1（或 `replaceAll: true` 時的匹配數）。

### `deleteFile(opts)`

刪除技能內的單個檔案。`SKILL.md` 不能透過這條路徑刪 —— 用 `delete(scope, name)` 刪除整個技能。

```ts
deleteFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
}): Promise<void>
```

## 管理

### `install(opts)`

從 JSON 負載（內聯檔案）或封存安裝一個技能。

```ts
install(opts: {
  scope: SkillScope,
  payload: SkillInstallPayload,
  conflictStrategy?: 'skip' | 'replace',  // 預設: 衝突拋錯
}): Promise<{
  installed: boolean,
  conflict?: 'same' | 'different',
  name: string,
}>
```

`SkillInstallPayload` 為以下兩種之一：

```ts
// 內聯檔案（推薦給純文字技能，≤ 10 檔案，每個 ≤ 64 KB）
{
  bundleFormat: 'inline-files-v1',
  name: string,
  files: Array<{ path: string, encoding: 'utf8' | 'base64', content: string }>
}

// base64 編碼的 zip（最大可達單技能上限）
{
  bundleFormat: 'archive-base64-v1',
  name: string,
  fileName: string,
  contentBase64: string,
  sha256: string,
}
```

目標作用域存在同名技能時：

- 內容相同（雜湊匹配）→ 靜默 no-op。
- 內容不同 → 拋錯，除非 `conflictStrategy: 'replace'`。`'skip'` 在衝突時 no-op。

### `delete(scope, name)`

```ts
delete(scope: SkillScope, name: string): Promise<void>
```

原子移除技能目錄。參照該技能的編排器 profile 仍保留 `skills.visible` 裡的舊名 —— 派遣時參照軟失敗。

### `rename(scope, oldName, newName)`

```ts
rename(scope: SkillScope, oldName: string, newName: string): Promise<void>
```

原子改名目錄與 frontmatter `name`。參照不會自動更新。

### `moveScope(name, fromScope, toScope)`

```ts
moveScope(
  name: string,
  fromScope: SkillScope,
  toScope: SkillScope,
): Promise<void>
```

跨作用域原子檔案系統 move。編排器參照（只按名字）依然有效。想要覆蓋目標，先刪目標作用域裡的同名技能再 move 即可。

### `importBundled()`

從 `default/skills/global/` 重裝所有出廠技能，覆蓋任何同名本地副本。

```ts
importBundled(): Promise<{
  installed: number,   // 處理的出廠技能總數
  replaced: number,    // 本地存在、被覆蓋的
  added: number,       // 本地不存在、新增的
}>
```

::: warning 破壞性
這是技能版的 `git reset --hard` —— 它把每個同名全域技能都覆蓋成出廠版本。先備份本地修改。
:::

### `listBundledManifest()`

列出 `default/skills/global/` 下出廠的技能，每個都附帶匯入後會生成的 install 雜湊。**瀏覽出廠** tab 用這個來跟本地安裝對比，無需重跑 install。

```ts
listBundledManifest(): Promise<Array<{
  name: string,
  installedHash: string,
  fileCount: number,
  totalBytes: number,
  description: string,
}>>
```

## 傳輸

這些函式支援透過角色卡和預設跨主機分發技能。

### `packForEmbed(opts)`

把一個或多個技能打包成嵌入負載，可塞進預設或角色卡。

```ts
packForEmbed(opts: {
  scope: SkillScope,
  names: string[],
  mode?: 'inline-files-v1' | 'archive-base64-v1' | 'auto',  // 預設 'auto'
}): Promise<EmbeddedPayload>
```

`EmbeddedPayload`：

```ts
{
  version: 1,
  items: Array<SkillInstallPayload>
}
```

`mode: 'auto'` 時打包器按每技能自選：小且純文字的用內聯，更大或二進位的用封存。

編排器的嵌入匯出鉤子會把負載寫入 `preset.extensions.luker.embedded_skills_source`（預設）或 `character.data.extensions.luker.embedded_skills_source`（角色卡），在儲存時持久化。

### `previewExtractEmbed(opts)`

預覽把嵌入負載抽取進目標作用域的衝突結果。唯讀 —— 不改檔案系統。

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

技能管理的匯入對話框用它來渲染每技能的跳過/替換選項。

### `executeExtractEmbed(opts)`

用每技能的衝突解決方案執行抽取。

```ts
executeExtractEmbed(opts: {
  payload: EmbeddedPayload,
  targetScope: SkillScope,
  conflictStrategies?: Record<string, 'skip' | 'replace'>,
}): Promise<{
  installed: string[],   // 已安裝的名字
  skipped: string[],     // 跳過的名字（按 conflictStrategies 或 'same'）
  failed: Array<{ name: string, error: string }>,
}>
```

`conflictStrategies` 按技能名為 key；缺失條目預設按 `'different'` 拋錯。`'same'` 條目永遠靜默 no-op。

### `importFromUrl(opts)`

從 HTTPS URL 拉取單個 `SKILL.md` 並作為單檔案技能安裝。

```ts
importFromUrl(opts: {
  url: string,         // 必須是 https://
  targetScope: SkillScope,
}): Promise<{
  name: string,
  conflict: 'new' | 'same' | 'different',
}>
```

多檔案技能不能透過 URL 匯入 —— 用 `install()` 配 `archive-base64-v1` 負載（或技能管理的**從檔案匯入**流程）。

## 錯誤處理

所有方法在伺服器錯誤時拋錯。拋出的 `Error` 攜帶：

| 屬性 | 型別 | 說明 |
|---|---|---|
| `.message` | `string` | 伺服器錯誤訊息。 |
| `.status` | `number` | HTTP 狀態碼（如 `404`、`409`、`400`）。 |
| `.body` | `object` | 解析後的響應體（通常 `{ error, code, ... }`）。 |

常見形狀：

```js
try {
  await context.skills.editFile({ ... });
} catch (err) {
  if (err.status === 409) {
    // SHA 不匹配 —— 檔案在我們讀之後被改過。重載再試。
  } else if (err.status === 404) {
    // 找不到技能或檔案。
  } else {
    throw err;
  }
}
```

## CardApp 對等

CardApp 的 `ctx.skills` 介面與 `context.skills.*` 1:1 鏡像 —— 簽名相同、返回形狀相同。CardApp 可以套用同樣的範式：

```js
async function init(ctx) {
  // 列出對任何人可見的技能（CardApp 不受編排器
  // per-agent 可見性過濾 —— 它們看到的是原始庫存）。
  const skills = await ctx.skills.list({ scope: 'all' });

  // 讀一個技能的正文
  const { content } = await ctx.skills.readFile({
    scope: { kind: 'character', characterFile: ctx.characterFile },
    name: 'card-voice-rules',
  });

  ctx.setVariable('voice_rules', content);
}
```

`ctx.skills` 包裝層有意保持很薄 —— 永遠不會比 `getContext().skills` 富。新的 API 添加會同時落在兩處。

## 相關

- [技能概覽](/zh-TW/features/skills/) —— 什麼是技能、三種作用域
- [創作技能](/zh-TW/features/skills/authoring) —— frontmatter + 正文約定
- [技能管理](/zh-TW/features/skills/management) —— 同等操作的 UI 介面
- [編排器整合](/zh-TW/features/skills/orchestrator-integration) —— 執行時如何按 `skills.visible` / `deny` 過濾
- [擴充 API 概覽](/zh-TW/development/extension-api/) —— `context.*` 上的其它命名空間
