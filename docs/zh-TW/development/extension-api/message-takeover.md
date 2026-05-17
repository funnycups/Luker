# 訊息接管

讓外掛**直接產出助理訊息本體**而非引導主 LLM 的 API。當外掛為某個回合宣告接管後,主 LLM 完全不會被呼叫 —— 由外掛把正文和 reasoning 寫進一個純緩衝編輯器控制代碼,核心負責把結果放進 chat、做持久化、跑正規表達式 / cleanup 後處理、觸發生命週期事件,在外掛 discard 時回滾。

::: warning 僅緩衝核心
控制代碼是一個純文字 / reasoning 緩衝。它不直接操作 `chat`、不觸發 ST 事件、不渲染任何東西 —— 這些都由核心依控制代碼的生命週期來驅動。更高層的編輯輔助(增量追加、結構化補丁、串流管道)放在外掛層實作。編排器擴充在 `public/scripts/extensions/orchestrator/editor-ops.js` 提供了參考實作 —— 依外掛需要選擇複製、依賴或取代它即可。
:::

## 鉤子事件

核心 `Generate()` 流程在 LLM 載荷完全裝配完成、但還沒分派之前,會觸發 `event_types.GENERATE_TAKEOVER_DISPATCH`。訂閱方透過填入 `eventData.takeoverHandle` 宣告接管:

```js
const context = Luker.getContext();

context.eventSource.on(context.eventTypes.GENERATE_TAKEOVER_DISPATCH, async (eventData) => {
    if (!shouldTakeover(eventData)) return;

    // 對 continue / swipe / regenerate,從既有的 chat slot 讀取原始內容,
    // 讓核心在 discard 時能正確回滾。
    const { originalText, originalReasoning } = resolveOriginals(eventData.type, context.chat);

    const handle = context.createMessageEditorHandle({
        generationType: eventData.type,
        originalText,
        originalReasoning,
        abortSignal: eventData.abortSignal,
        owner: 'my-plugin',
    });
    eventData.takeoverHandle = handle;

    // 非同步驅動 editor。核心會 await handle.complete,負責推入佔位、
    // 訂閱 onUpdate 做即時重繪,並在終態把流程路由到
    // saveReply / patchChatMessages。
    void (async () => {
        try {
            handle.setText('外掛產出的訊息本體。');
            await handle.commit();
        } catch (err) {
            await handle.discard();
        }
    })();
});

function resolveOriginals(type, chat) {
    if (type === 'normal') return { originalText: '', originalReasoning: '' };
    const slot = chat[chat.length - 1];
    return {
        originalText: String(slot?.mes ?? ''),
        originalReasoning: String(slot?.extra?.reasoning ?? ''),
    };
}
```

### 事件載荷

```ts
type DispatchEventData = {
    type: 'normal' | 'regenerate' | 'swipe' | 'continue';   // 其他類型不觸發該事件。
    isContinue: boolean;                                     // 是否為 Continue(需保留前綴)
    forceName2: boolean;                                     // 如有需要,傳給你自己的提示詞流程
    isStreamingEnabled: boolean;                             // 使用者目前是否啟用串流
    finalPrompt: unknown;                                    // 本將送出給 LLM 的最終 prompt
    generateData: unknown;                                   // 原始 generate-data 信封(等同 GENERATE_AFTER_DATA 載荷)
    takeoverHandle: MessageEditorHandle | null;              // 訂閱方填入以宣告接管
    abortSignal: AbortSignal;                                // 接管與正常路徑都遵守此訊號
};
```

如果沒有訂閱方宣告接管,正常的 LLM 分派會照常進行。如果多個訂閱方都嘗試宣告,先到先得;後續的賦值會被記錄為警告。`quiet` 和 `impersonate` 這兩種生成類型**不會**觸發該事件。

`isStreamingEnabled` 為使用者**工作階段層級**的偏好,來源是 `isStreamingEnabled()`(也就是決定主 LLM 路徑走 `sendStreamingRequest` 還是 `sendOpenAIRequest` 的同一個 flag)。如果你的外掛自行驅動 LLM 呼叫(例如在 `generateTask` 與 `generateTaskStream` 之間擇一),應尊重此值以與 UI 其他行為保持一致。帶有自身串流開關的外掛可以進一步覆寫(編排器的「使用串流傳輸」profile 開關即為一例)。

## 職責劃分

外掛負責:

- 監聽 dispatch 事件,決定是否宣告接管。
- 依 generationType 用合適的 `originalText` / `originalReasoning` 建構控制代碼。
- 透過 `setText` / `setReasoning` 把最終的文字和 reasoning 寫進緩衝。
- 成功時呼叫 `commit()`,硬失敗時呼叫 `discard()`。

核心負責:

- 把佔位訊息推入 `chat`(`normal` 類型),或重用既有的 slot(`regenerate` / `swipe` / `continue`)。
- 透過 `addOneMessage` 渲染佔位,透過 `appendChatMessages` 持久化。
- 訂閱控制代碼的節流 `onUpdate`,讓外掛串流輸出時實現即時重繪。
- `commit` 時:經由 `saveReply` 路由,讓 swipes 初始化、正規表達式 / cleanup 後處理、`MESSAGE_RECEIVED`、`CHARACTER_MESSAGE_RENDERED`、token 計數、統計、自動化功能等所有生成副作用都按正常路徑觸發。
- `discard` 時:透過 `patchChatMessages` 回滾 chat slot(`normal` 用 `op:remove`;`continue` / `swipe` / `regenerate` 用 `op:replace` 還原原始內容),並觸發 `GENERATION_STOPPED`。

核心**不會**做時間觸發的 abort。使用者點擊停止時,abort 訊號透過 `eventData.abortSignal` 傳遞,外掛應當尊重這個訊號(典型作法:在被 abort 的串流呼叫 catch 內呼叫 `discard()`)。如果外掛忽略 abort 訊號,控制代碼會一直處於未結算狀態 —— 那是外掛 bug,核心不會兜底。

## 編輯器控制代碼

```ts
interface CreateOpts {
    generationType: 'normal' | 'regenerate' | 'swipe' | 'continue';
    originalText?: string;            // 預設 '' —— 用於 discard 回滾與 continue 前綴校驗
    originalReasoning?: string;       // 預設 ''
    abortSignal?: AbortSignal;        // 傳入 dispatch 事件的訊號
    flushIntervalMs?: number;         // 預設 33 —— onUpdate 節流視窗
    owner?: string;                   // 預設 'unknown' —— 診斷用識別字
}

interface MessageEditorHandle {
    getText(): string;
    getReasoning(): string;

    setText(text: string): void;
    setReasoning(text: string): void;

    commit(): Promise<void>;
    discard(): Promise<void>;
    readonly complete: Promise<{
        status: 'committed' | 'discarded';
        finalText: string;
        finalReasoning: string;
    }>;

    readonly abortSignal: AbortSignal;

    // 面向核心 —— 外掛通常不需要用到。
    setOnUpdate(fn: ((text: string, reasoning: string) => void) | null): void;
}
```

| 操作 | 行為 |
|------|------|
| `setText(text)` | 整體替換文字緩衝。排入一次合併刷新(預設 33ms),呼叫核心的 onUpdate 回呼做即時重繪。`text` 不是字串時拋 `invalid_argument`;到達終態後改寫拋 `editor_committed` / `editor_discarded`;`generationType === 'continue'` 時若新文字不保留原前綴,拋 `invalid_op_for_continue`。 |
| `setReasoning(text)` | reasoning 緩衝的同語義版本,無前綴不變量。 |
| `commit()` | 標記控制代碼已提交,強制刷出待處理更新,以 `{ status: 'committed', finalText, finalReasoning }` resolve `complete`。已提交時再呼叫一次是 no-op(冪等)。對已 discard 的控制代碼呼叫會拋 `editor_discarded`。 |
| `discard()` | 標記控制代碼已廢棄,取消任何待刷新,以 `{ status: 'discarded', finalText: originalText, finalReasoning: originalReasoning }` resolve `complete`。兩種終態下皆冪等。 |
| `complete` | 在 `commit` 或 `discard` 完成時 resolve。核心 await 它來判斷該回合是否已結束。 |
| `abortSignal` | 回傳 `opts.abortSignal` 傳入的同一個訊號。核心**不會**在 abort 時自動 discard —— 由外掛自行決定策略(典型作法:在被 abort 的串流呼叫 catch 內呼叫 `discard()`)。 |
| `setOnUpdate(fn)` | 核心用它訂閱節流後的緩衝更新。傳 `null` 取消訂閱。掛上回呼時如有待處理更新會立即刷出。 |

### `continue` 前綴不變量

當 `opts.generationType === 'continue'` 時,如果傳給 `setText(newText)` 的 `newText` 不以 `opts.originalText` 開頭,會拋 `invalid_op_for_continue`。這個檢查用來攔截最常見的坑 —— 外掛不小心把使用者希望繼續的前綴整段抹掉。做 `continue` 的外掛必須在前綴之上累積。

### 錯誤碼

`TakeoverError` 帶有 `code`、`message`,以及可選的 `cause` / `details`:

| 錯誤碼 | 觸發場景 |
|--------|----------|
| `invalid_generation_type` | `opts.generationType` 缺失,或不是四個合法值之一。 |
| `invalid_argument` | `setText` / `setReasoning` 收到非字串值。 |
| `editor_committed` | `commit()` resolve 後仍有改寫呼叫。 |
| `editor_discarded` | `discard()` resolve 後仍有改寫呼叫,或對已 discard 的控制代碼呼叫 `commit()`。 |
| `invalid_op_for_continue` | `continue` 模式下 `setText` 會抹掉原前綴。 |

## 更高層的編輯模式

核心刻意不提供增量追加、按字元位移切片、結構化補丁套用或串流管道 —— 這些都是*策略*,不是狀態管理。編排器擴充在 `public/scripts/extensions/orchestrator/editor-ops.js` 實作了這些能力:

- `appendText(handle, text)` / `appendReasoning(handle, text)` —— 在目前值後面銜接。
- `insertAt(handle, offset, text)` / `replaceRange(handle, start, end, text)` / `deleteRange(handle, start, end)` —— 按字元位移切片。
- `applyPatch(handle, patch | patch[])` —— 套用結構化補丁(種類:`replace_range`、`insert_at`、`delete_range`、`context_replace`)。
- `patchBySemantic(handle, { find, replaceWith, occurrence? })` —— Git 風格的 context_replace(Aider / Claude Code / Cursor 風格),按位元組精確匹配,不做啟發式修復。
- `pipeFrom(handle, stream, opts?)` —— 把一個 `AsyncIterable<StreamChunk>`(例如從 `generateTaskStream` 回傳的)以 `mode: 'append'` 或 `mode: 'replace'` 的方式餵進編輯器。

其他外掛可以選擇依賴 `orchestrator/editor-ops.js`,也可以自行實作一套 —— 核心不在意。

## 三層暴露

| 層 | 存取方式 |
|----|----------|
| Layer 1 | `import { createMessageEditorHandle, GENERATE_TAKEOVER_DISPATCH, TakeoverError } from 'public/scripts/message-takeover.js'` |
| `getContext()` | `Luker.getContext().createMessageEditorHandle(...)` + `Luker.getContext().eventTypes.GENERATE_TAKEOVER_DISPATCH` |
| 擴充 `ctx` | `ctx.lukerContext.createMessageEditorHandle(...)` + `ctx.lukerContext.eventTypes.GENERATE_TAKEOVER_DISPATCH` |
