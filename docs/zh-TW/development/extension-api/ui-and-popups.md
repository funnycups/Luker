# UI 與彈窗

顯示對話框、長操作期間阻塞 UI、渲染外掛範本、格式化訊息內容的相關 API。

## 彈窗

### Popup 類別

```ts
new Popup(content: string | HTMLElement | JQuery, type: POPUP_TYPE, inputValue?: string, options?: PopupOptions): Popup
```

完整控制的彈窗原語。當你需要拿到結果、自訂按鈕，或輸入控制項時用它。

| `PopupOptions` 欄位 | 說明 |
|------|------|
| `okButton` / `cancelButton` | 自訂按鈕文字。傳 `false` 隱藏 |
| `rows` | 輸入框行數（INPUT 類型） |
| `placeholder` | 輸入框佔位符 |
| `tooltip` | 彈窗本體上的 tooltip |
| `wide` / `wider` / `large` | 尺寸預設 |
| `transparent` | 透明背景 |
| `defaultResult` | esc 關閉時的預設 `POPUP_RESULT` |
| `customButtons` | `{ text, tooltip?, result?, classes?, icon?, action?, appendAtEnd? }` 陣列 |
| `customInputs` | `{ id, label, tooltip?, defaultState?, type?, rows?, min?, max?, step?, disabled? }` 陣列 |
| `allowEscapeClose` | 允許 esc 關閉 |
| `onOpen(popup)` / `onClosing(popup)` / `onClose(popup)` | 生命週期鉤子 |
| `cropAspect` / `cropImage` | CROP 類型設定 |

### Popup 實例方法

| 方法 | 回傳 | 備註 |
|------|------|------|
| `await popup.show()` | `Promise<string \| number \| boolean \| null>` | 加入 + 顯示。以結果值解析 |
| `await popup.complete(result)` | `Promise<void>` | 程式化關閉。`onClosing` 取消時回傳 `undefined` |
| `popup.completeAffirmative()` | — | OK 的捷徑 |
| `popup.completeNegative()` | — | Cancel 的捷徑 |
| `popup.completeCancelled()` | — | Esc 的捷徑 |

`popup.value` 在 INPUT 類型下持有輸入字串；`popup.cropData` 在 CROP 類型下持有資料 URL。

### POPUP_TYPE

```ts
context.POPUP_TYPE: {
    TEXT: 1,        // 內容 + 按鈕
    CONFIRM: 2,     // Yes / No 焦點
    INPUT: 3,       // 文字輸入，回傳值
    DISPLAY: 4,     // 僅內容，X 關閉
    CROP: 5,        // 圖像裁切，回傳資料 URL
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

未指定 `result` 欄位的自訂按鈕會自動取得 `CUSTOM1`–`CUSTOM9` 值。

### callGenericPopup

```ts
callGenericPopup(
    content: string | HTMLElement | JQuery,
    type: POPUP_TYPE,
    inputValue?: string,
    popupOptions?: PopupOptions,
): Promise<POPUP_RESULT | string | boolean | null>
```

`new Popup(...).show()` 的函式式捷徑。當你不需要持有彈窗實例的參照時用它。

```js
const ctx = Luker.getContext();

// 確認
const result = await ctx.callGenericPopup(
    'Delete this conversation?',
    ctx.POPUP_TYPE.CONFIRM,
);
if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
    // ...
}

// 輸入
const userInput = await ctx.callGenericPopup(
    'Enter your name:',
    ctx.POPUP_TYPE.INPUT,
    'Anonymous',
    { rows: 1 },
);

// 僅顯示
await ctx.callGenericPopup(
    '<h3>Done</h3><p>Plugin initialized.</p>',
    ctx.POPUP_TYPE.DISPLAY,
);
```

### callPopup（已棄用）

```ts
callPopup(text: string, type: string, ...): Promise<any>
```

使用字串鍵類型（`'text'`、`'confirm'`、`'input'` 等）的傳統彈窗輔助函式。請遷移到 `callGenericPopup` 並使用數字 `POPUP_TYPE` 值。

## 載入器

### loader.show / loader.hide

```ts
loader.show(options?: ActionLoaderOptions): ActionLoaderHandle
loader.hide(handle?: ActionLoaderHandle): Promise<void>
```

長操作期間阻塞 UI 的推薦 API。`loader.show()` 回傳一個 handle；把它傳回給 `loader.hide(handle)` 可只關閉這一個 loader。`loader.hide()` 不帶引數則隱藏所有 loader。

| `ActionLoaderOptions` 欄位 | 預設 | 說明 |
|------|------|------|
| `blocking` | `true` | overlay 是否阻擋輸入 |
| `toastMode` | `'stoppable'` | `'none'` / `'static'` / `'stoppable'` |
| `slug` | `null` | 用於 handle 查找的可選 ID |
| `message` | `'Generating...'` | overlay 中顯示的文字 |
| `title` | `''` | 訊息上方的可選標題 |
| `stopTooltip` | `'Stop'` | 停止按鈕的 tooltip |
| `overlayContent` | `null` | 自訂 DOM 內容 |
| `onStop` | `null` | 使用者點 Stop 時呼叫 |
| `onHide` | `null` | loader 隱藏時呼叫 |

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

### loader 命名空間工具

| 方法 | 說明 |
|------|------|
| `loader.active()` | 當前所有活躍的 handle |
| `loader.get(id)` | 按 id 查 handle |
| `loader.isBlocking()` | 是否有任何阻塞 loader 處於活躍狀態 |
| `loader.ToastMode` | toast 模式列舉 |
| `loader.Handle` | `ActionLoaderHandle` 類別 |
| `loader.createOverlay()` | 建構預設的 overlay 元素 |

### showLoader / hideLoader（已棄用）

舊的入口點。請遷移到 `loader.show` / `loader.hide`。傳統的 `showLoader()` 現在只是個薄包裝，會委派給現代 API。

## 範本

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

從 `scripts/extensions/${extensionName}/${templateId}.html` 載入 HTML 範本並回傳渲染後的 HTML。會應用消毒（DOMPurify）和本地化（i18n 自動翻譯）。

對於位於 `scripts/extensions/third-party/MyExt/dialog.html` 的第三方擴充功能：

```js
const ctx = Luker.getContext();
const html = await ctx.renderExtensionTemplateAsync('third-party/MyExt', 'dialog', {
    title: 'Settings',
    items: ['a', 'b', 'c'],
});
const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY);
await popup.show();
```

### renderExtensionTemplate（已棄用）

同步版本。請遷移到 async 版本——底層的載入器是非同步的，同步版本會阻塞事件迴圈。

## 訊息格式化

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

回傳訊息渲染後的 HTML，會應用：
- Markdown 渲染
- 自訂 CSS 類別注入
- 程式碼語法高亮
- 巨集替換
- 正則流水線（依 flag 走 `AI_OUTPUT` / `USER_INPUT` 位置）

當你在外掛 UI 中渲染類訊息內容（例如預覽彈窗）時用它，這樣風格能與聊天一致。

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

Luker 全域 markdown 設定好的共享 `showdown.Converter` 實例（emoji、字中底線、表格、GitHub-flavored 擴充等）。用 `.makeHtml(source)` 渲染 markdown 跟 Luker 聊天管道一致,無需自建 converter 再鏡像它的 option 集。Live binding——每次存取取最新值（markdown 選項變更時底層 converter 會重建）。

```js
const ctx = Luker.getContext();
const html = ctx.markdownConverter.makeHtml('**hello**');
```

## 工具包裝

### ModuleWorkerWrapper

```ts
new ModuleWorkerWrapper(updateFn: () => Promise<void>): { update(): Promise<void> }
```

週期性 worker 函式的互斥鎖包裝——上一次 tick 還沒結束時，會避免 tick 重疊。典型用法：

```js
const ctx = Luker.getContext();

const worker = new ctx.ModuleWorkerWrapper(async () => {
    await doExpensiveTick();
});

// 週期性觸發；併發呼叫會被串行化
setInterval(() => worker.update(), 5000);
```

### Toasts

Toast 通知使用全域的 `toastr` 函式庫（見 [toastr.js 文件](https://github.com/CodeSeven/toastr)）。隨處可用——因為它已經是全域變數，所以不透過 `getContext()` 暴露：

```js
toastr.success('Imported successfully');
toastr.warning('Some entries skipped', 'Import Warning', { timeOut: 5000 });
toastr.error('Import failed: ' + error.message);
```
