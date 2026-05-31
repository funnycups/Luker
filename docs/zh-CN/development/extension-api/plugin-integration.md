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

### CONNECT_API_MAP

```ts
context.CONNECT_API_MAP: Record<string, ConnectApiEntry>
```

支持的 API 源标识（如 `'openai'`、`'claude'`、`'novel'`）及其 UI 元数据的只读目录。在填充连接相关下拉框时有用。

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

当前活动主 API、配置的最大上下文长度、当前打开的右侧面板菜单类型的活只读视图。
