# 插件集成

把插件接入 Luker 流水线、以及插件之间互通的 API：正则处理、搜索工具、跨插件 API 注册表、事件系统。

## 正则运行时 API

插件可以通过 `registerManagedRegexProvider()` 注册托管的正则处理器，参与 Luker 的正则处理流程。该函数从正则引擎模块导出：

```js
import { registerManagedRegexProvider } from '../../extensions/regex/engine.js';

const handle = registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

// 添加正则脚本
handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: 'foo',
  replaceString: 'bar',
  // ...其他正则脚本字段
});

// 卸载时取消注册
handle.unregister();
```

`registerManagedRegexProvider` 返回的句柄提供 `upsertScript`、`removeScript`、`setScripts`、`clearScripts` 和 `unregister` 方法。

## 搜索工具 API

搜索插件通过 `Luker.searchTools` 全局对象暴露 API，供其他插件调用搜索能力：

```js
// 检查搜索插件是否可用
if (globalThis?.Luker?.searchTools) {
  // 获取可用的搜索工具名称列表
  const toolNames = Luker.searchTools.toolNames;
  // 获取工具定义（用于函数调用）
  const toolDefs = Luker.searchTools.getToolDefs();
  // 检查某个工具名是否属于搜索工具
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` 暴露的是工具定义元数据，实际的搜索执行通过内部的工具调用循环完成。详见[搜索插件](/zh-CN/features/search-tools)。

## 扩展间通信

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

将一个API对象注册到指定名称下，供其他扩展通过`getExtensionApi`获取。如果同名API已被注册，会在控制台输出警告并覆盖。

### getExtensionApi

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

按名称获取其他扩展注册的API对象。如果该名称尚未注册，返回`undefined`。

### 典型用途

扩展间通信最常见的场景是解耦：一个扩展提供能力，另一个扩展消费能力，而不需要硬编码依赖。例如，CardApp Studio通过`registerExtensionApi`将自身的编辑器API暴露出来，其他扩展可以在Studio就绪后直接调用。

编排器扩展遵循同样的约定 —— 它发布 `'orchestrator'`，带 `registerOrchestrationTool` / `unregisterOrchestrationTool` / `listExtensionTools`（以及 SillyTavern 桥接相关的辅助函数），让任何其他扩展都能贡献工具，由编排 agent 调用。详见 [编排器工具 API](./orchestrator-tools.md)。

## 事件系统

### eventSource

```js
// 监听
context.eventSource.on(eventName, handler, options?);

// 取消监听
context.eventSource.off(eventName, handler);

// 确保最先执行
context.eventSource.makeFirst(eventName, handler);

// 确保最后执行
context.eventSource.makeLast(eventName, handler);

// 查看监听器信息（调试用）
context.eventSource.getListenersMeta(eventName);

// 配置插件排序
context.eventSource.setOrderConfig(config);
```

### 监听器选项

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // 数字越大越先执行
});
```

### 事件类型

所有事件类型通过 `context.eventTypes` 访问。完整集合涵盖聊天生命周期、消息事件、生成钩子和应用级信号。

| 分组 | 示例 |
|------|------|
| 聊天生命周期 | `CHAT_CHANGED`、`CHAT_LOADED`、`CHAT_BRANCH_CREATED` |
| 消息事件 | `MESSAGE_SENT`、`MESSAGE_RECEIVED`、`MESSAGE_RENDERED`、`MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`、`MESSAGE_SWIPE_DELETED` |
| 生成钩子 | `GENERATION_STARTED`、`GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN`、`GENERATION_BEFORE_API_REQUEST`、`GENERATION_ENDED`、`GENERATION_STOPPED`、`WORLD_INFO_ACTIVATED` |
| 图像生成 | `IMAGE_GENERATION_STARTED`、`IMAGE_GENERATION_ENDED` |
| 应用级 | `APP_READY`、`SETTINGS_LOADED_AFTER`、`EXTENSIONS_FIRST_LOAD` |

完整的事件 payload 结构参见 [前端插件开发 → 事件系统](/zh-CN/development/frontend-plugin#事件系统)。

## 国际化（i18n）

插件应通过 i18n 辅助函数本地化用户可见字符串。语言数据在 `zh-CN ↔ zh-TW` 之间互为回退。

### t（模板字符串标签）

```ts
t`Tag ${name} not found`
```

带标签的模板字符串字面量，使用模板形式 `'Tag ${0} not found'` 作为查找 key，再把 `name` 替换回结果中。运行时翻译最顺手的 API。

### translate

```ts
translate(text: string, key?: string | null): string
```

在已加载的语言数据中查找 `text`（提供 `key` 时用 `key`）。未找到条目时原样返回 `text`。当你有不带插值的静态字符串时使用。

### getCurrentLocale

```ts
getCurrentLocale(): string
```

返回启动时解析的小写 locale 标识——通常是 `'en'`、`'zh-cn'`、`'zh-tw'`、`'ja-jp'` 等。如果你需要按 locale 分支行为，读这个。

### addLocaleData

```ts
addLocaleData(localeId: string, data: Record<string, string>): void
```

把插件提供的翻译合并到已加载的语言数据中。请在 i18n 系统启动后调用（例如在 `APP_READY` 时）。当 `localeId` 是主 locale 时条目始终覆盖；当它是回退 locale 时条目只填充缺失的 key。

```js
const ctx = Luker.getContext();

ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    ctx.addLocaleData('zh-cn', {
        'My Plugin': '我的插件',
        'Settings saved': '设置已保存',
    });
    ctx.addLocaleData('en', {
        'My Plugin': 'My Plugin',
        'Settings saved': 'Settings saved',
    });
});
```

## 设置与存储

### extensionSettings

```ts
context.extensionSettings: object
```

全局的纯对象，扩展在这里存储自己的配置。每个扩展通常使用自己的命名空间 key：

```js
const ctx = Luker.getContext();

if (!ctx.extensionSettings.my_extension) {
    ctx.extensionSettings.my_extension = { enabled: true, level: 1 };
}

ctx.extensionSettings.my_extension.level += 1;
ctx.saveSettingsDebounced();
```

### saveSettingsDebounced

```ts
context.saveSettingsDebounced(): void
```

debounce 形式的持久化触发。修改 `extensionSettings` 或任何设置对象后调用。短时间内多次调用会合并成一次保存。

### saveSettings

```ts
context.saveSettings(loopCounter?: number, options?: object): Promise<void>
```

`saveSettingsDebounced` 的可 await 版本。绕过 debounce 队列,网络往返完成后才解决。仅当后续逻辑依赖「设置已落盘」时才用（罕见——绝大多数调用点都应优先选 debounce 版）。

### saveMetadataDebounced

```ts
context.saveMetadataDebounced(): void
```

`chat_metadata` 修改的 debounce 形式 `saveMetadata` 包装。

### getExtensionManifest

```ts
getExtensionManifest(name: string): ExtensionManifest | null
```

返回指定扩展 manifest 的结构化克隆。可接受短名（`SillyTavern-MyExt`）或内部 key（`third-party/SillyTavern-MyExt`）；查找忽略大小写和重音符。未找到时返回 `null`。

### openThirdPartyExtensionMenu

```ts
openThirdPartyExtensionMenu(suggestUrl?: string): Promise<void>
```

打开第三方扩展安装对话框。提供 `suggestUrl` 时预填 URL 字段。

### accountStorage

```ts
context.accountStorage: {
    getItem(key: string): string | null,
    setItem(key: string, value: any): void,
    removeItem(key: string): void,
    getState(): object,
}
```

账户作用域的 key/value 存储。值会被强制为字符串。通过 `saveSettingsDebounced` 持久化。适合存储跨聊天保留、但不应随角色卡导出的用户专属设置。

```js
const ctx = Luker.getContext();
ctx.accountStorage.setItem('my-extension:last-seen', String(Date.now()));
const lastSeen = ctx.accountStorage.getItem('my-extension:last-seen');
```

## 调试函数

### registerDebugFunction

```ts
registerDebugFunction(
    functionId: string,
    name: string,
    description: string,
    func: () => void | Promise<void>,
): void
```

在用户设置的调试菜单里加一个按钮。点击时调用 `func`。适合插件维护操作（清缓存、dump 状态、强制重载等）。

```js
const ctx = Luker.getContext();
ctx.registerDebugFunction(
    'my-plugin-clear-cache',
    'Clear my-plugin cache',
    'Removes all cached data stored by my-plugin.',
    () => {
        ctx.extensionSettings.my_plugin.cache = {};
        ctx.saveSettingsDebounced();
        toastr.success('Cache cleared');
    },
);
```

## 数据库抓取器（Data Bank Scrapers）

### registerDataBankScraper

```ts
registerDataBankScraper(scraper: {
    id: string,
    name: string,
    description: string,
    iconClass: string,
    iconAvailable: boolean,
    init?: () => Promise<void>,
    isAvailable: () => Promise<boolean>,
    scrape: () => Promise<File[]>,
}): void
```

注册自定义的 Data Bank 来源。当用户在 Data Bank UI 中选中该抓取器时，调用 `scrape()`，返回的 `File[]` 会被加入数据库。

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识；重复注册会被拒绝 |
| `name` / `description` | 抓取器选择器中显示的内容 |
| `iconClass` | FontAwesome class（如 `'fa-solid fa-globe'`） |
| `iconAvailable` | 图标是否可渲染 |
| `init` | 可选的一次性初始化；按需懒调用 |
| `isAvailable` | 当前是否可执行（前置条件已满足） |
| `scrape` | 执行抓取；返回新文件 |

## Tokenization（分词）

用于 token 计数任务（预算控制、上下文窗口计算）。

### getTokenCountAsync

```ts
getTokenCountAsync(text: string, padding?: number): Promise<number>
```

使用当前活动 tokenizer 返回 `text` 的 token 数。按 `${tokenizerType}-${hash}${modelHash}+${padding}` 缓存。空输入返回 `0`。

### getTextTokens

```ts
getTextTokens(tokenizerType: number, text: string): Promise<number[]>
```

返回 token id 列表。`tokenizerType` 是 `context.tokenizers.*` 之一（如 `context.tokenizers.OPENAI`、`context.tokenizers.LLAMA3`）。不支持编码的 tokenizer 返回 `[]`。

### getTokenizerModel

```ts
getTokenizerModel(): string
```

返回 tokenizer 配置的模型标识（如 `'gpt-4o'`、`'claude'`、`'llama3'`）。

### tokenizers

```ts
context.tokenizers: { NONE, GPT2, OPENAI, LLAMA, LLAMA3, MISTRAL, GEMMA, CLAUDE, ... }
```

支持的 tokenizer 类型的数字枚举。作为 `getTextTokens` 的第一个参数传入。

## 工具辅助函数

### uuidv4

```ts
uuidv4(): string
```

返回一个 RFC 4122 UUID v4。可用时使用 `crypto.randomUUID()`，否则用十六进制字符串回退。

### timestampToMoment

```ts
timestampToMoment(timestamp: string | number): moment.Moment
```

返回按 `getCurrentLocale()` 本地化的 `moment` 对象。无法解析输入时返回 `moment.invalid()`。

### humanizedDateTime

```ts
humanizedDateTime(timestamp?: number): string
```

返回适合作为文件名的时间戳字符串，格式 `YYYY-MM-DD@HHhMMmSSsMSms`。默认取 `Date.now()`。

### isMobile

```ts
isMobile(): boolean
```

移动端或平板平台（解析 UA）时返回 `true`。

### shouldSendOnEnter

```ts
shouldSendOnEnter(): boolean
```

按用户偏好和平台决定回车键是否应该发送（vs 插入换行）。

### escapeHtml

```ts
context.escapeHtml(str: string): string
```

转义 `&`、`<`、`>`、`"`、`'`,便于把纯文本安全嵌入 HTML。比手写转义更稳。

### download

```ts
context.download(content: string | Blob, fileName: string, contentType: string): void
```

按指定文件名和 MIME 类型触发浏览器下载。`content` 可以是字符串或 `Blob`。

### getFileText

```ts
context.getFileText(file: File): Promise<string>
```

把 `<input type="file">` change 事件里的 `File` 当文本读出。读取失败时拒绝。

### getStringHash

```ts
context.getStringHash(str: string, seed?: number): number
```

稳定的 32 位 FNV 风格哈希。适合做缓存 key、按内容 debounce 的标识、「上次以来变没变」之类的判断。**不是**加密哈希。

### createThumbnail

```ts
context.createThumbnail(dataUrl: string, maxWidth?: number, maxHeight?: number, type?: string): Promise<string>
```

把 data URL 解码为图片再缩成新的 data URL 返回。type 默认 `'image/jpeg'`。任一维度传 `null` 表示只按另一维度约束。

### isValidUrl

```ts
context.isValidUrl(value: string): boolean
```

`value` 能被 `new URL()` 解析时返回 `true`。发起 fetch 前做输入校验用。

### performFuzzySearch

```ts
context.performFuzzySearch(
    type: string,
    data: object[],
    keys: Array<string | { name: string, weight?: number }>,
    searchValue: string,
    fuzzySearchCaches?: object | null,
): Array<{ item: object, score: number, refIndex: number }>
```

在平台已命名的某个索引（`'characters'`、`'groups'`、`'tags'` 等）上跑一次 Fuse.js 模糊匹配,按相关度排序返回 Fuse 风格的结果对象。传入一个 out-cache 对象可在多次调用之间复用构建好的索引。

## 库捆绑（Lib Bundle）

插件偶尔需要用到核心已经打包进 `lib.core.bundle.js` 的第三方库。比起在每个插件里再打一遍或者依赖全局对象,推荐走 `context.lib`。

### context.lib

```ts
context.lib: {
    DOMPurify,
    lodash,
    DiffMatchPatch,
    showdown,
    yaml,
}
```

| 字段 | 库 |
|------|------|
| `DOMPurify` | HTML 消毒器（[DOMPurify](https://github.com/cure53/DOMPurify)） |
| `lodash` | 工具集合（[lodash](https://lodash.com/)） |
| `DiffMatchPatch` | diff/patch 引擎（[diff-match-patch](https://github.com/google/diff-match-patch)） |
| `showdown` | Markdown → HTML（[showdown](https://github.com/showdownjs/showdown)） |
| `yaml` | YAML 解析/序列化（[yaml](https://eemeli.org/yaml/)） |

```js
const ctx = Luker.getContext();
const safe = ctx.lib.DOMPurify.sanitize(userHtml);
const md = new ctx.lib.showdown.Converter().makeHtml(text);
```

## 密钥（Secrets）

供插件检查或列举连接密钥槽（API key、凭据等）的状态。context 表面只读——具体的 key 值留在 secrets 后端。

### context.secrets.KEYS

```ts
context.secrets.KEYS: Record<string, string>
```

公认的密钥槽标识目录（`OPENAI`、`CLAUDE`、`MISTRALAI` 等）。当作 `context.secrets.state` 的 key 使用。

### context.secrets.state

```ts
context.secrets.state: Record<string, boolean>
```

每个密钥槽当前是否已填的布尔实时映射。只读快照——直接修改不会持久化。

```js
const ctx = Luker.getContext();
if (!ctx.secrets.state[ctx.secrets.KEYS.OPENAI]) {
    toastr.warning('OpenAI API key 未设置。');
}
```

## 向量嵌入服务

### context.embeddingService

```ts
context.embeddingService: {
    embed(items: string[], options?: object): Promise<number[][]>,
    // ……EmbeddingService 完整表面
}
```

vectors / memory-graph 子系统共用的向量嵌入服务,会按当前配置的嵌入 provider 走。需要做相似度检索又不想自己复写一遍 provider 装配的插件可以用。

## 符号与常量

### context.symbols.ignore

```ts
context.symbols.ignore: typeof IGNORE_SYMBOL
```

哨兵 symbol，在 `null` 和 `undefined` 各有他用的 patch 上下文里表示「保持该值不变」。

### context.constants.unset

```ts
context.constants.unset: typeof UNSET_VALUE
```

哨兵值，传给 `writeExtensionField` / `writeExtensionFieldBulk` 用于**删除** key 而不是把它设为 `null`：

```js
await ctx.writeExtensionField(chid, 'my_field', ctx.constants.unset);  // 删除
await ctx.writeExtensionField(chid, 'my_field', null);                  // 设为 null
```

### context.constants.promptRoles / promptTypes

```ts
context.constants.promptRoles: { SYSTEM, USER, ASSISTANT }
context.constants.promptTypes: { NONE, IN_PROMPT, IN_CHAT, BEFORE_PROMPT }
```

`setExtensionPrompt` 及相关注入路径用的数值枚举。`promptRoles` 选择被注入 prompt 的 message role;`promptTypes` 选择注入位置。

```js
const ctx = Luker.getContext();
ctx.setExtensionPrompt(
    'my-plugin-pre',
    '前置上下文备注。',
    ctx.constants.promptTypes.BEFORE_PROMPT,
    0,
    false,
    ctx.constants.promptRoles.SYSTEM,
);
```

关于 `wiAnchor` / `wiPosition` 见[世界书 → 位置常量](/zh-CN/development/extension-api/world-info#位置常量)。

### CONNECT_API_MAP

```ts
context.CONNECT_API_MAP: Record<string, ConnectApiEntry>
```

支持的 API 源标识（如 `'openai'`、`'claude'`、`'novel'`）及其 UI 元数据的只读目录。在填充连接相关下拉框时有用。

### createModelIcon

```ts
context.createModelIcon(apiName: string, modelName?: string): string
```

返回某 provider 品牌图标的内联 SVG 标记,尺寸适合嵌在下拉框 / chip 里和模型名并排。`apiName` 传 `CONNECT_API_MAP` 的某个 key;可选的 `modelName` 让 helper 挑特定模型的变体（例如 Claude 普通 vs Claude reasoning）。

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

当前活动主 API、配置的最大上下文长度、当前打开的右侧面板菜单类型的活只读视图。
