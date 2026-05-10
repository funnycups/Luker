# 宏与变量

注册自定义宏、对文本求值宏、读写聊天作用域或全局变量的相关 API。

## 宏

Luker 通过 `macros` 命名空间提供宏系统，同时为向后兼容保留了 `MacrosParser`。<span v-pre>`{{user}}`</span>、<span v-pre>`{{char}}`</span>、<span v-pre>`{{lastMessage}}`</span>、<span v-pre>`{{getvar::name}}`</span> 等内置宏由核心注册；插件可以通过 `macros.register()` 添加自己的宏。

### macros.register

```ts
macros.register(name: string, options: {
    handler: (ctx: MacroExecutionContext) => string,
    aliases?: { alias: string, visible?: boolean }[],
    category?: string,
    unnamedArgs?: number | UnnamedArgDef[],
    list?: boolean | { min: number, max?: number },
    strictArgs?: boolean,
    description?: string,
    returns?: string,
    returnType?: 'string' | 'integer' | 'number' | 'boolean',
    displayOverride?: string,
    exampleUsage?: string | string[],
    delayArgResolution?: boolean,
}): MacroDefinition | null
```

注册宏。返回注册成功的定义；校验失败则返回 `null`。

| 选项 | 说明 |
|------|------|
| `handler` | 宏主体。接收带解析后参数的执行上下文 |
| `aliases` | 备用名。每个 `{ alias, visible }` 注册同一处理器 |
| `category` | 自动补全里的分组（如 `'utility'`、`'character'`、`'time'`） |
| `unnamedArgs` | 数量（全部必填）或参数定义数组 |
| `list` | 是否接受可变长度的参数列表 |
| `strictArgs` | 为 `false` 时，arity / 类型不匹配只 log 警告而不抛错 |
| `delayArgResolution` | 为 `true` 时，参数中的嵌套宏**不**会被预先解析——处理器必须自己调用 `ctx.resolve(text)`。仅用于控制流式宏 |

#### 处理器上下文

处理器收到 `MacroExecutionContext`，包含：

| 字段 | 说明 |
|------|------|
| `name` | 调用时使用的宏名 |
| `args` | 命名参数的值 |
| `unnamedArgs` | 非命名位置参数 |
| `list` | 可变长度的列表参数 |
| `env` | 宏求值环境（聊天、角色、persona 等） |
| `normalize(value)` | 把值强制为该宏的返回类型 |
| `trimContent(content, opts?)` | 修剪多行块 |
| `resolve(text, opts?)` | 解析 `text` 中的嵌套宏 |
| `warn(message, error?)` | 记录归属于此宏的警告 |

```js
const ctx = Luker.getContext();

ctx.macros.register('myStatus', {
    description: 'Returns the plugin status string.',
    category: 'utility',
    handler: () => 'My plugin is active.',
});

ctx.macros.register('greet', {
    description: 'Greets a name.',
    unnamedArgs: [
        { name: 'name', optional: false, type: 'string', description: 'Person to greet' },
    ],
    handler: (mctx) => `Hello, ${mctx.unnamedArgs[0]}!`,
});
```

注册后，<span v-pre>`{{myStatus}}`</span> 和 <span v-pre>`{{greet::Bob}}`</span> 都能工作。

### macros.registry

底层的注册表。可用于反注册和检视：

```js
ctx.macros.registry.unregisterMacro('myStatus');
ctx.macros.registry.hasMacro('greet');
const def = ctx.macros.registry.getMacro('greet');
```

### 内置宏参考

下面是核心注册的宏的非穷尽列表。完整覆盖请见 `public/scripts/macros/definitions/` 下的源码。

| 宏 | 返回 |
|------|------|
| <span v-pre>`{{user}}`</span> | 当前用户 / persona 名 |
| <span v-pre>`{{char}}`</span> | 当前角色名 |
| <span v-pre>`{{persona}}`</span> | 当前 persona 描述 |
| <span v-pre>`{{charDescription}}`</span> / <span v-pre>`{{charPersonality}}`</span> / <span v-pre>`{{charScenario}}`</span> | 卡片字段 |
| <span v-pre>`{{charDepthPrompt}}`</span> / <span v-pre>`{{charCreatorNotes}}`</span> / <span v-pre>`{{charFirstMessage}}`</span> / <span v-pre>`{{charVersion}}`</span> | 卡片字段 |
| <span v-pre>`{{mesExamples}}`</span> / <span v-pre>`{{mesExamplesRaw}}`</span> | 对话示例 |
| <span v-pre>`{{group}}`</span> / <span v-pre>`{{groupNotMuted}}`</span> | 群组成员名 |
| <span v-pre>`{{lastMessage}}`</span> / <span v-pre>`{{lastMessageId}}`</span> / <span v-pre>`{{lastUserMessage}}`</span> / <span v-pre>`{{lastCharMessage}}`</span> | 最近聊天内容 |
| <span v-pre>`{{firstIncludedMessageId}}`</span> / <span v-pre>`{{firstDisplayedMessageId}}`</span> | 可见性窗口 |
| <span v-pre>`{{lastSwipeId}}`</span> / <span v-pre>`{{currentSwipeId}}`</span> | swipe 状态 |
| <span v-pre>`{{model}}`</span> | 当前模型标识 |
| <span v-pre>`{{maxPrompt}}`</span> / <span v-pre>`{{maxContext}}`</span> / <span v-pre>`{{maxResponse}}`</span> | token 预算 |
| <span v-pre>`{{time}}`</span> / <span v-pre>`{{date}}`</span> / <span v-pre>`{{weekday}}`</span> / <span v-pre>`{{isotime}}`</span> / <span v-pre>`{{isodate}}`</span> | 本地时钟 |
| <span v-pre>`{{datetimeformat::FORMAT}}`</span> | `moment.format(FORMAT)` |
| <span v-pre>`{{idleDuration}}`</span> / <span v-pre>`{{timeDiff}}`</span> | 时间差 |
| <span v-pre>`{{getvar::name}}`</span> / <span v-pre>`{{setvar::name::value}}`</span> / <span v-pre>`{{addvar::name::value}}`</span> | 本地变量 |
| <span v-pre>`{{incvar::name}}`</span> / <span v-pre>`{{decvar::name}}`</span> / <span v-pre>`{{hasvar::name}}`</span> / <span v-pre>`{{deletevar::name}}`</span> | 本地变量 |
| <span v-pre>`{{getglobalvar::name}}`</span> / <span v-pre>`{{setglobalvar::name::value}}`</span> / ... | 全局变量 |
| <span v-pre>`{{if::cond::then::else}}`</span> / <span v-pre>`{{else::...}}`</span> / <span v-pre>`{{each::...}}`</span> | 控制流 |
| <span v-pre>`{{trim}}`</span> / <span v-pre>`{{newline}}`</span> / <span v-pre>`{{space}}`</span> / <span v-pre>`{{noop}}`</span> | 空白辅助 |
| <span v-pre>`{{roll::XdY}}`</span> / <span v-pre>`{{random::a,b,c}}`</span> / <span v-pre>`{{pick::a,b,c}}`</span> | 随机 |
| <span v-pre>`{{//comment}}`</span> | 注释（输出忽略） |
| <span v-pre>`{{outlet::name}}`</span> | 自定义 WI outlet 内容 |
| <span v-pre>`{{isMobile}}`</span> / <span v-pre>`{{hasExtension::name}}`</span> | 环境检查 |
| <span v-pre>`{{lastGenerationType}}`</span> / <span v-pre>`{{systemPrompt}}`</span> | 流水线状态 |

### MacrosParser（已弃用）

```ts
MacrosParser.registerMacro(key: string, value: string | (nonce) => string, description?: string): void
MacrosParser.unregisterMacro(key: string): void
```

旧版的简单字符串替换宏注册 API。会记录弃用警告。请迁移到 `macros.register({ handler })` 以获得完整能力，或在一次性调用中给 `substituteParams` 传 `dynamicMacros`。

### substituteParams

```ts
substituteParams(content: string, options?: {
    name1Override?: string,
    name2Override?: string,
    original?: string,
    groupOverride?: string,
    replaceCharacterCard?: boolean,
    dynamicMacros?: Record<string, string | (() => string)>,
    postProcessFn?: (text: string) => string,
}): string
```

解析 `content` 中的所有宏。`dynamicMacros` 可以为单次调用注入临时的零参数宏：

```js
const result = ctx.substituteParams('Hello, {{user}}! Today is {{date}}.');
```

### substituteParamsExtended

```ts
substituteParamsExtended(
    content: string,
    additionalMacros?: Record<string, string | (() => string)>,
    postProcessFn?: (text: string) => string,
): string
```

`substituteParams` 的便捷封装，仅为本次调用添加 `additionalMacros`：

```js
const result = ctx.substituteParamsExtended(
    'Query: {{queryText}}',
    { queryText: userInput },
);
```

`additionalMacros` 不会被全局注册——它们只对这一次替换有效。

## 变量

有两种作用域可用：**本地**（按聊天，持久化在 `chat_metadata.variables`）和**全局**（跨聊天，持久化在 `extension_settings.variables.global`）。

### 本地变量

```ts
context.variables.local.get(name: string, args?: object): string | number
context.variables.local.set(name: string, value: any, args?: object): any
context.variables.local.add(name: string, value: any): any
context.variables.local.inc(name: string): any
context.variables.local.dec(name: string): any
context.variables.local.del(name: string): ''
context.variables.local.has(name: string): boolean
```

| 方法 | 说明 |
|------|------|
| `get` | 读取变量。数字字符串自动强制为数字。不存在时返回 `''` |
| `set` | 写入变量。返回值 |
| `add` | 两者都是数字时执行加法。已有值是 JSON 数组时 push。否则按字符串拼接 |
| `inc` / `dec` | `add(name, ±1)` 的快捷方式 |
| `del` | 删除变量。返回 `''` |
| `has` | 布尔型存在性检查 |

`get` / `set` 上的可选 `args` 参数支持：
- `args.key`——备用变量名（覆盖 `name`）
- `args.index`——存在变量里的 JSON 列表 / 字典的索引 / key
- `args.as`（仅 set）——为索引写入将值强制为 `'string'` / `'number'` / `'boolean'`

### 全局变量

```ts
context.variables.global.get / set / add / inc / dec / del / has
```

接口与本地相同。跨聊天持久化。

### 使用示例

```js
const ctx = Luker.getContext();

// 读本地变量并给默认值
const turns = Number(ctx.variables.local.get('turns_taken')) || 0;

// 自增
ctx.variables.local.inc('turns_taken');

// 检查并初始化全局配置变量
if (!ctx.variables.global.has('api_endpoint')) {
    ctx.variables.global.set('api_endpoint', 'https://api.example.com');
}
const endpoint = ctx.variables.global.get('api_endpoint');

// 索引写入：往本地变量里的 JSON 列表的某个位置写
ctx.variables.local.set('inventory', 'sword', { index: 0, as: 'string' });
ctx.variables.local.set('inventory', 'shield', { index: 1, as: 'string' });
```

### 本地 vs 全局

| | 本地 | 全局 |
|------|------|------|
| 作用域 | 单个聊天 | 所有聊天 |
| 存储 | `chat_metadata.variables` | `extension_settings.variables.global` |
| 保存触发 | `saveMetadataDebounced` | `saveSettingsDebounced` |
| 适用场景 | 聊天专属计数器、阶段性状态 | 插件配置、跨聊天数据 |
