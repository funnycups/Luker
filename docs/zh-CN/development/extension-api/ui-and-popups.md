# UI 与弹窗

显示对话框、在长操作期间阻塞 UI、渲染插件模板、格式化消息内容的相关 API。

## 弹窗

### Popup 类

```ts
new Popup(content: string | HTMLElement | JQuery, type: POPUP_TYPE, inputValue?: string, options?: PopupOptions): Popup
```

完整可控的弹窗原语。当你需要返回值、自定义按钮或输入控件时使用。

| `PopupOptions` 字段 | 说明 |
|------|------|
| `okButton` / `cancelButton` | 自定义按钮文本。传 `false` 隐藏 |
| `rows` | 输入行数（INPUT 类型） |
| `placeholder` | 输入占位符 |
| `tooltip` | 弹窗主体的 tooltip |
| `wide` / `wider` / `large` | 尺寸预设 |
| `transparent` | 透明背景 |
| `defaultResult` | Esc 关闭时的默认 `POPUP_RESULT` |
| `customButtons` | `{ text, tooltip?, result?, classes?, icon?, action?, appendAtEnd? }` 数组 |
| `customInputs` | `{ id, label, tooltip?, defaultState?, type?, rows?, min?, max?, step?, disabled? }` 数组 |
| `allowEscapeClose` | 是否允许 Esc 关闭 |
| `onOpen(popup)` / `onClosing(popup)` / `onClose(popup)` | 生命周期钩子 |
| `cropAspect` / `cropImage` | CROP 类型配置 |

### Popup 实例方法

| 方法 | 返回 | 备注 |
|------|------|------|
| `await popup.show()` | `Promise<string \| number \| boolean \| null>` | 追加 + 显示。resolve 时返回结果值 |
| `await popup.complete(result)` | `Promise<void>` | 程序化关闭。`onClosing` 取消时返回 `undefined` |
| `popup.completeAffirmative()` | — | OK 的快捷方式 |
| `popup.completeNegative()` | — | Cancel 的快捷方式 |
| `popup.completeCancelled()` | — | Esc 的快捷方式 |

`popup.value` 保存 INPUT 类型的输入字符串；`popup.cropData` 保存 CROP 类型的 data URL。

### POPUP_TYPE

```ts
context.POPUP_TYPE: {
    TEXT: 1,        // 内容 + 按钮
    CONFIRM: 2,     // Yes / No 焦点
    INPUT: 3,       // 文本输入，返回值
    DISPLAY: 4,     // 仅内容，X 关闭
    CROP: 5,        // 图片裁剪，返回 data URL
}
```

### POPUP_RESULT

```ts
context.POPUP_RESULT: {
    AFFIRMATIVE: 1,
    NEGATIVE: 0,
    CANCELLED: null,
    CUSTOM1: 1001,
    // ...
    CUSTOM9: 1009,
}
```

未填 `result` 字段的自定义按钮会被自动分配 `CUSTOM1`–`CUSTOM9` 值。

### callGenericPopup

```ts
callGenericPopup(
    content: string | HTMLElement | JQuery,
    type: POPUP_TYPE,
    inputValue?: string,
    popupOptions?: PopupOptions,
): Promise<POPUP_RESULT | string | boolean | null>
```

`new Popup(...).show()` 的函数式快捷方式。当你不需要持有弹窗实例引用时使用。

```js
const ctx = Luker.getContext();

// 确认
const result = await ctx.callGenericPopup(
    'Delete this conversation?',
    ctx.POPUP_TYPE.CONFIRM,
);
if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
    // ...
}

// 输入
const userInput = await ctx.callGenericPopup(
    'Enter your name:',
    ctx.POPUP_TYPE.INPUT,
    'Anonymous',
    { rows: 1 },
);

// 仅展示
await ctx.callGenericPopup(
    '<h3>Done</h3><p>Plugin initialized.</p>',
    ctx.POPUP_TYPE.DISPLAY,
);
```

### callPopup（已弃用）

```ts
callPopup(text: string, type: string, ...): Promise<any>
```

旧版弹窗助手，使用字符串键的类型（`'text'`、`'confirm'`、`'input'` 等）。请迁移到 `callGenericPopup`，使用数字 `POPUP_TYPE` 值。

## 加载器

### loader.show / loader.hide

```ts
loader.show(options?: ActionLoaderOptions): ActionLoaderHandle
loader.hide(handle?: ActionLoaderHandle): Promise<void>
```

在长操作期间阻塞 UI 的推荐 API。`loader.show()` 返回一个 handle；把它传回 `loader.hide(handle)` 可关闭那一个加载器。`loader.hide()` 不带参数则关闭所有加载器。

| `ActionLoaderOptions` 字段 | 默认值 | 说明 |
|------|------|------|
| `blocking` | `true` | 遮罩是否阻塞输入 |
| `toastMode` | `'stoppable'` | `'none'` / `'static'` / `'stoppable'` |
| `slug` | `null` | 用于 handle 查找的可选 ID |
| `message` | `'Generating...'` | 遮罩内显示的文本 |
| `title` | `''` | 文本上方的可选标题 |
| `stopTooltip` | `'Stop'` | Stop 按钮的 tooltip |
| `overlayContent` | `null` | 自定义 DOM 内容 |
| `onStop` | `null` | 用户点击 Stop 时调用 |
| `onHide` | `null` | 加载器隐藏时调用 |

```js
const ctx = Luker.getContext();

const handle = ctx.loader.show({
    message: 'Importing...',
    toastMode: 'stoppable',
    onStop: () => abortController.abort(),
});

try {
    await doImport();
} finally {
    await ctx.loader.hide(handle);
}
```

### loader 命名空间工具

| 方法 | 说明 |
|------|------|
| `loader.active()` | 当前所有活动 handle |
| `loader.get(id)` | 按 id 查找 handle |
| `loader.isBlocking()` | 是否有阻塞型加载器在活动 |
| `loader.ToastMode` | toast 模式枚举 |
| `loader.Handle` | `ActionLoaderHandle` 类 |
| `loader.createOverlay()` | 构建默认遮罩元素 |

### showLoader / hideLoader（已弃用）

旧版入口。请迁移到 `loader.show` / `loader.hide`。旧的 `showLoader()` 现在只是一层薄封装，转发到现代 API。

## 模板

### renderExtensionTemplateAsync

```ts
renderExtensionTemplateAsync(
    extensionName: string,
    templateId: string,
    templateData?: object,
    sanitize?: boolean,
    localize?: boolean,
): Promise<string>
```

从 `scripts/extensions/${extensionName}/${templateId}.html` 加载 HTML 模板并返回渲染后的 HTML。会应用 sanitization（DOMPurify）和本地化（i18n 自动翻译）。

对于位于 `scripts/extensions/third-party/MyExt/dialog.html` 的第三方扩展：

```js
const ctx = Luker.getContext();
const html = await ctx.renderExtensionTemplateAsync('third-party/MyExt', 'dialog', {
    title: 'Settings',
    items: ['a', 'b', 'c'],
});
const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY);
await popup.show();
```

### renderExtensionTemplate（已弃用）

同步版本。请迁移到异步版本——底层 loader 是异步的，同步版本会阻塞事件循环。

## 消息格式化

### messageFormatting

```ts
messageFormatting(
    mes: string,
    ch_name: string,
    isSystem: boolean,
    isUser: boolean,
    messageId: number,
    sanitizerOverrides?: object,
    isReasoning?: boolean,
): string
```

返回消息渲染后的 HTML，会应用：
- Markdown 渲染
- 自定义 CSS class 注入
- 代码语法高亮
- 宏替换
- 正则流水线（根据 flag 在 `AI_OUTPUT` / `USER_INPUT` 位置生效）

当你在插件 UI（例如预览弹窗）中渲染类消息内容、并希望与聊天样式一致时使用。

```js
const ctx = Luker.getContext();
const html = ctx.messageFormatting(
    rawText,
    'Preview',
    /* isSystem */ false,
    /* isUser */ false,
    /* messageId */ -1,
);
```

### markdownConverter

```ts
context.markdownConverter: showdown.Converter
```

Luker 全局 markdown 配置好的共享 `showdown.Converter` 实例（emoji、字中下划线、表格、GitHub-flavored 扩展等）。用 `.makeHtml(source)` 渲染 markdown 跟 Luker 聊天管道一致,无需自建 converter 再镜像它的 option 集。Live binding——每次访问取最新值（markdown 选项变更时底层 converter 会重建）。

```js
const ctx = Luker.getContext();
const html = ctx.markdownConverter.makeHtml('**hello**');
```

## 工具封装

### ModuleWorkerWrapper

```ts
new ModuleWorkerWrapper(updateFn: () => Promise<void>): { update(): Promise<void> }
```

用于周期性 worker 函数的互斥封装——前一次 tick 还没结束时，避免重叠执行。常见用法：

```js
const ctx = Luker.getContext();

const worker = new ctx.ModuleWorkerWrapper(async () => {
    await doExpensiveTick();
});

// 周期性触发；并发调用会被串行化
setInterval(() => worker.update(), 5000);
```

### Toast

Toast 通知使用全局 `toastr` 库（参见 [toastr.js 文档](https://github.com/CodeSeven/toastr)）。无处不在——因为它本身就是全局对象，不通过 `getContext()` 暴露：

```js
toastr.success('Imported successfully');
toastr.warning('Some entries skipped', 'Import Warning', { timeOut: 5000 });
toastr.error('Import failed: ' + error.message);
```
