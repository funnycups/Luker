# 消息接管

让插件**直接产出助理消息正文**而非引导主 LLM 的 API。当插件为某个回合声明接管后，主 LLM 完全不被调用 —— 由插件把正文和 reasoning 写进一个纯 buffer 编辑器句柄，内核负责把结果落进 chat、做持久化、跑正则 / cleanup 后处理、触发生命周期事件，在插件 discard 时回滚。

::: warning 仅 buffer 内核
句柄是一个纯文本 / reasoning buffer。它不直接操作 `chat`、不触发 ST 事件、不渲染任何东西 —— 这些都由内核根据句柄的生命周期来驱动。更高层的编辑辅助（增量追加、结构化补丁、流式管道）放在插件层实现。编排器扩展在 `public/scripts/extensions/orchestrator/editor-ops.js` 提供了参考实现 —— 按插件需要选择复制、依赖或替换它即可。
:::

## 钩子事件

内核 `Generate()` 流程在 LLM 载荷完全装配完成、但还没分发之前，会触发 `event_types.GENERATE_TAKEOVER_DISPATCH`。订阅方通过填充 `eventData.takeoverHandle` 声明接管：

```js
const context = Luker.getContext();

context.eventSource.on(context.eventTypes.GENERATE_TAKEOVER_DISPATCH, async (eventData) => {
    if (!shouldTakeover(eventData)) return;

    // 对 continue / swipe / regenerate,从已存在的 chat slot 读取原内容,
    // 以便内核在 discard 时能正确回滚。
    const { originalText, originalReasoning } = resolveOriginals(eventData.type, context.chat);

    const handle = context.createMessageEditorHandle({
        generationType: eventData.type,
        originalText,
        originalReasoning,
        abortSignal: eventData.abortSignal,
        owner: 'my-plugin',
    });
    eventData.takeoverHandle = handle;

    // 异步驱动 editor。内核会 await handle.complete,负责 push 占位、
    // 订阅 onUpdate 做实时重绘,并在终态把流程路由到对应清理 pipeline。
    void (async () => {
        try {
            for await (const chunk of streamFromMyBackend(eventData)) {
                handle.setText(handle.getText() + chunk);
            }
            await handle.commit();
        } catch (err) {
            if (err.name === 'AbortError' || eventData.abortSignal.aborted) {
                // 用户点了停止。保留已经流出来的部分,但跳过 finalize pipeline
                //  —— 见下面的「三种终态」一节。
                await handle.abort();
            } else {
                // 没有可用 partial 的硬失败。恢复 slot 原状。
                await handle.discard();
            }
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

### 事件载荷

```ts
type DispatchEventData = {
    type: 'normal' | 'regenerate' | 'swipe' | 'continue';   // 其他类型不触发该事件。
    isContinue: boolean;                                     // 是否 Continue(需保留前缀)
    forceName2: boolean;                                     // 如有用,传给你自己的提示词流程
    isStreamingEnabled: boolean;                             // 用户当前是否启用了流式
    finalPrompt: unknown;                                    // 本可送给 LLM 的最终 prompt
    generateData: unknown;                                   // 原始 generate-data 信封(等同 GENERATE_AFTER_DATA 载荷)
    takeoverHandle: MessageEditorHandle | null;              // 订阅方填入以声明接管
    abortSignal: AbortSignal;                                // 接管与正常路径都遵守此信号
};
```

如果没有订阅方声明接管，正常的 LLM 分发会照常进行。如果多个订阅方都尝试声明，先到先得；后续的赋值会被记录为警告。`quiet` 和 `impersonate` 这两种生成类型**不会**触发该事件。

`isStreamingEnabled` 是用户**会话级**的偏好，来自 `isStreamingEnabled()`（即决定主 LLM 路径走 `sendStreamingRequest` 还是 `sendOpenAIRequest` 的那同一个 flag）。如果你的插件自行驱动 LLM 调用（比如在 `generateTask` 与 `generateTaskStream` 之间二选一），应该尊重此值以与 UI 其它行为保持一致。带有自己流式开关的插件可以进一步覆写（编排器的「使用流式传输」profile 开关就是一例）。

## 三种终态

句柄会进入三种终态之一，每种触发不同的内核清理 pipeline。选对终态很关键 —— 内核对每种终态跑的下游工作不同，选错了（比如用户点停止时调 `commit()`）会和下一回合产生 race condition。

| 方法 | 插件什么时候调 | 内核响应 | `outcome.status` |
|------|---------------|-----------|------------------|
| `commit()` | 自然完成 —— 插件给出了最终输出 | 完整 finalize pipeline：触发 `MESSAGE_RECEIVED` / `CHARACTER_MESSAGE_RENDERED`，跑正则 / cleanup 后处理，经由 `appendChatMessages` / `saveChatConditional` 持久化，触发自动化功能（autoContinue、swipe 初始化），解锁 UI | `committed` |
| `abort()` | 用户中途取消 —— 保留已流出来的内容但不持久化 | 同步把 partial 写进 chat slot 并 redraw;**跳过** finalize pipeline（不 emit、不 save、不 autoContinue）；有条件地解锁 UI（只在后续没有新的生成已经持锁的情况下）。partial 在本地 chat 留着，直到用户下一次操作把它覆盖 —— 跟 ST 核心 streaming 路径在 `streamingProcessor.isStopped` 为 true 时一致的取舍 | `aborted` |
| `discard()` | 显式回滚 —— partial 输出不可用，恢复 pre-takeover 状态 | 回滚：把占位 splice 出 `chat`（`normal` / `regenerate`）或恢复原 `mes` / `reasoning`(`continue` / `swipe`)；触发 `GENERATION_STOPPED`；解锁 UI | `discarded` |

三种终态互斥 —— 句柄一旦进入任一终态，再调用另两个会抛错（`editor_committed` / `editor_aborted` / `editor_discarded`）。同一终态再调一次是 no-op。

**用户停止时该选哪个：** 优先 `abort()`。用户点停止时希望保留 partial 看看停止前生成到哪了，但**不**希望把它当成最终输出固化下来 —— 在被 abort 的 partial 上跑完整 finalize pipeline（emit、save、autoContinue）会跟用户接下来点的 regenerate 撞车，因为 finalize pipeline 含多处 `await` yield，在这些 yield 之间下一个 `Generate()` 会启动。只在 partial 会误导用户的情况下用 `discard()`（比如插件产出了一段格式坏掉的正文，与其展示不如丢掉）。

## 职责划分

插件负责：

- 监听 dispatch 事件，决定是否声明接管。
- 根据 generationType 用合适的 `originalText` / `originalReasoning` 构造句柄。
- 通过 `setText` / `setReasoning` 把最终的文本和 reasoning 写进 buffer。
- 在 `commit()` / `abort()` / `discard()` 三者中**恰好调一个**来让句柄进入终态。

内核负责：

- 把占位消息 push 进 `chat`（`normal` 类型），或复用已存在的 slot（`regenerate` / `swipe` / `continue`）。
- 通过 `addOneMessage` 渲染占位，通过 `appendChatMessages` 持久化。
- 订阅句柄的限频 `onUpdate`，让插件流式输出时实现实时重绘。
- 句柄进入终态后，路由到对应的清理 pipeline（详见上面「三种终态」一节）。

内核**不会**做时间触发的 abort。用户点击停止时，abort 信号通过 `eventData.abortSignal` 传递，插件应当尊重这个信号（典型做法：在被 abort 的流式调用 catch 里调 `abort()`）。如果插件忽略 abort 信号，句柄会一直处于未结算状态 —— 那是插件 bug，内核不会兜底。

## 编辑器句柄

```ts
interface CreateOpts {
    generationType: 'normal' | 'regenerate' | 'swipe' | 'continue';
    originalText?: string;            // 默认 '' —— 用于 discard 回滚和 continue 前缀校验
    originalReasoning?: string;       // 默认 ''
    abortSignal?: AbortSignal;        // 传 dispatch 事件的信号
    flushIntervalMs?: number;         // 默认 33 —— onUpdate 限频窗口
    owner?: string;                   // 默认 'unknown' —— 诊断用标识
}

interface MessageEditorHandle {
    getText(): string;
    getReasoning(): string;

    setText(text: string): void;
    setReasoning(text: string): void;

    commit(): Promise<void>;
    abort(): Promise<void>;
    discard(): Promise<void>;
    readonly complete: Promise<{
        status: 'committed' | 'aborted' | 'discarded';
        finalText: string;
        finalReasoning: string;
    }>;

    readonly abortSignal: AbortSignal;

    // 面向内核 —— 插件通常不需要用到这个。
    setOnUpdate(fn: ((text: string, reasoning: string) => void) | null): void;
}
```

| 操作 | 行为 |
|------|------|
| `setText(text)` | 整体替换文本 buffer。排队一次合并刷新（默认 33ms），调用内核的 onUpdate 回调做实时重绘。`text` 不是字符串抛 `invalid_argument`；到达终态后改写抛 `editor_committed` / `editor_aborted` / `editor_discarded`;`generationType === 'continue'` 时若新文本不保留原前缀，抛 `invalid_op_for_continue`。 |
| `setReasoning(text)` | reasoning buffer 的同语义版本，无前缀不变量。 |
| `commit()` | 让句柄进入 committed 终态，强制刷出待处理更新，以 `{ status: 'committed', finalText, finalReasoning }` resolve `complete`。已 committed 时再调一次是 no-op（幂等）。对已 aborted 或已 discarded 的句柄调用会抛错。 |
| `abort()` | 让句柄进入 aborted 终态，强制刷出待处理更新（让内核读到最新流式 buffer），以 `{ status: 'aborted', finalText, finalReasoning }` resolve `complete`。已 aborted 时再调一次是 no-op（幂等）。对已 committed 或已 discarded 的句柄调用会抛错。 |
| `discard()` | 让句柄进入 discarded 终态，取消任何待刷新，以 `{ status: 'discarded', finalText: originalText, finalReasoning: originalReasoning }` resolve `complete`。已 discarded 时再调一次是 no-op（幂等）。对已 committed 或已 aborted 的句柄调用会抛错。 |
| `complete` | 三个终态之一让句柄结算时 resolve。内核 await 它来判断回合是否已结束。 |
| `abortSignal` | 返回 `opts.abortSignal` 传入的同一个信号。内核**不会**在 abort 时自动结算 —— 由插件自行决定策略（典型做法：在被 abort 的流式调用 catch 里调 `abort()`）。 |
| `setOnUpdate(fn)` | 内核用它订阅限频后的 buffer 更新。传 `null` 取消订阅。挂上回调时如果有待处理更新会立即刷出。 |

### `continue` 前缀不变量

当 `opts.generationType === 'continue'` 时，如果传给 `setText(newText)` 的 `newText` 不以 `opts.originalText` 开头，会抛 `invalid_op_for_continue`。这个检查用来拦截最常见的坑 —— 插件不小心把用户希望继续的前缀整段抹掉。做 `continue` 的插件必须在前缀之上累积。

### 错误码

`TakeoverError` 携带 `code`、`message`，以及可选的 `cause` / `details`:

| 错误码 | 触发场景 |
|--------|----------|
| `invalid_generation_type` | `opts.generationType` 缺失，或不是四个合法值之一。 |
| `invalid_argument` | `setText` / `setReasoning` 接到非字符串值。 |
| `editor_committed` | `commit()` resolve 之后还有改写调用，或对已 committed 的句柄调用 `abort()` / `discard()`。 |
| `editor_aborted` | `abort()` resolve 之后还有改写调用，或对已 aborted 的句柄调用 `commit()` / `discard()`。 |
| `editor_discarded` | `discard()` resolve 之后还有改写调用，或对已 discarded 的句柄调用 `commit()` / `abort()`。 |
| `invalid_op_for_continue` | `continue` 模式下 `setText` 会抹掉原前缀。 |

## 更高层的编辑模式

内核刻意不提供增量追加、按字符偏移切片、结构化补丁应用或流式管道 —— 这些都是*策略*，不是状态管理。编排器扩展在 `public/scripts/extensions/orchestrator/editor-ops.js` 实现了这些能力：

- `appendText(handle, text)` / `appendReasoning(handle, text)` —— 在当前值后面拼接。
- `insertAt(handle, offset, text)` / `replaceRange(handle, start, end, text)` / `deleteRange(handle, start, end)` —— 按字符偏移切片。
- `applyPatch(handle, patch | patch[])` —— 应用结构化补丁（种类：`replace_range`、`insert_at`、`delete_range`、`context_replace`）。
- `patchBySemantic(handle, { find, replaceWith, occurrence? })` —— Git 风格的 context_replace（Aider / Claude Code / Cursor 风格），按字节精确匹配，不做启发式恢复。
- `pipeFrom(handle, stream, opts?)` —— 把一个 `AsyncIterable<StreamChunk>`（例如从 `generateTaskStream` 返回的）以 `mode: 'append'` 或 `mode: 'replace'` 的方式喂进编辑器。

其他插件可以选择依赖 `orchestrator/editor-ops.js`，也可以自己实现一套 —— 内核不关心。

## 三层暴露

| 层 | 访问方式 |
|----|----------|
| Layer 1 | `import { createMessageEditorHandle, GENERATE_TAKEOVER_DISPATCH, TakeoverError } from 'public/scripts/message-takeover.js'` |
| `getContext()` | `Luker.getContext().createMessageEditorHandle(...)` + `Luker.getContext().eventTypes.GENERATE_TAKEOVER_DISPATCH` |
| 扩展 `ctx` | `ctx.lukerContext.createMessageEditorHandle(...)` + `ctx.lukerContext.eventTypes.GENERATE_TAKEOVER_DISPATCH` |
