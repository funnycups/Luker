# 前端插件开发

Luker 的插件系统基于 SillyTavern 的扩展架构，并在此基础上进行了增强。本文档面向希望为 Luker 开发第三方插件的开发者，涵盖插件的文件结构、生命周期、事件系统、UI 集成和调试技巧。

## 术语说明

Luker 中「插件」和「扩展」（Extension）指同一概念。内置扩展位于 `public/scripts/extensions/` 目录下，第三方插件安装到 `public/scripts/extensions/third-party/` 目录。

## 插件文件结构

一个标准的 Luker 插件包含以下文件：

```
third-party/my-plugin/
├── manifest.json      # 插件元数据（必需）
├── index.js           # 入口脚本（必需）
├── style.css          # 样式文件（可选）
├── settings.html      # 设置面板 HTML（可选）
└── assets/            # 静态资源（可选）
```

### manifest.json

`manifest.json` 是插件的元数据文件，定义了插件的基本信息和加载方式：

```json
{
  "display_name": "My Plugin",
  "loading_order": 100,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "author": "Your Name",
  "version": "1.0.0",
  "homePage": "https://github.com/your-repo",
  "auto_update": true
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_name` | string | 插件在 UI 中显示的名称 |
| `loading_order` | number | 加载顺序，数字越小越先加载 |
| `requires` | string[] | 必需的依赖扩展列表 |
| `optional` | string[] | 可选的依赖扩展列表 |
| `js` | string | 入口 JavaScript 文件路径 |
| `css` | string | 样式文件路径 |
| `author` | string | 作者信息 |
| `version` | string | 版本号 |
| `homePage` | string | 项目主页 URL |
| `auto_update` | boolean | 是否支持自动更新 |

### index.js

入口脚本是插件的核心文件。Luker 使用 ES Module 动态导入加载插件，因此入口文件应使用 `import`/`export` 语法。

一个最小的入口脚本结构：

```js
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const EXTENSION_NAME = 'my-plugin';

// 插件设置的默认值
const defaultSettings = {
  enabled: true,
  someOption: 'default',
};

// 加载设置
function loadSettings() {
  extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};
  Object.assign(extension_settings[EXTENSION_NAME], {
    ...defaultSettings,
    ...extension_settings[EXTENSION_NAME],
  });
}

// 插件入口
jQuery(async () => {
  loadSettings();

  // 加载设置面板 HTML
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // 绑定事件
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
```

### style.css

样式文件会被自动加载。建议使用带有插件前缀的 CSS 类名，避免与其他插件或 Luker 核心样式冲突：

```css
.my-plugin-container {
  padding: 10px;
}

.my-plugin-container .status {
  color: var(--SmartThemeBodyColor);
}
```

### settings.html

设置面板的 HTML 片段，会被插入到扩展设置区域。使用 `data-extension-name` 属性标识所属插件：

```html
<div class="my-plugin-settings" data-extension-name="my-plugin">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>My Plugin</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
      <label>
        <input type="checkbox" id="my_plugin_enabled" />
        启用插件
      </label>
    </div>
  </div>
</div>
```

## 全局对象

### Luker.getContext()

`Luker.getContext()` 是插件与 Luker 交互的主要接口。它返回一个包含丰富 API 的上下文对象：

```js
const context = Luker.getContext();
```

> [!NOTE]
> `SillyTavern.getContext()` 和 `st.getContext()` 是兼容别名，新插件应使用 `Luker.getContext()`。

上下文对象包含以下主要类别的 API：

- **聊天数据** — `context.chat`、`context.characters`、`context.groups` 等
- **消息操作** — `addMessages()`、`updateMessages()`、`deleteMessages()`、`getMessage()`、`getMessageCount()`
- **聊天持久化** — `saveChatMetadata()` 等（底层的 `appendChatMessages()`、`patchChatMessages()` 已弃用，请使用消息 API）
- **聊天状态** — `getChatState()`、`updateChatState()` 等
- **预设** — `context.presets.list()`、`context.presets.resolve()` 等
- **提示词/世界书组装** — `buildPresetAwarePromptMessages()`、`simulateWorldInfoActivation()` 等
- **事件系统** — `context.eventSource`、`context.eventTypes`
- **角色状态** — `getCharacterState()`、`setCharacterState()`
- **扩展间通信** — `registerExtensionApi()`

完整的 API 列表请参阅 [扩展 API 参考](/zh-CN/development/extension-api/)。

## 事件系统

Luker 的事件系统是插件开发的核心机制。插件通过监听事件来响应用户操作和系统状态变化。

### 基本用法

```js
const context = Luker.getContext();

// 监听事件
context.eventSource.on(context.eventTypes.CHAT_CHANGED, (chatId) => {
  console.log('聊天已切换:', chatId);
});

// 带优先级的监听
context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, handler, { priority: 10 });

// 确保最先/最后执行
context.eventSource.makeFirst(context.eventTypes.CHAT_CHANGED, handler);
context.eventSource.makeLast(context.eventTypes.CHAT_CHANGED, handler);
```

### 监听器执行顺序

Luker 的事件监听器按以下优先级顺序**串行**执行（每个监听器会被 `await`）：

1. **显式插件排序**（`pluginOrder`）— 通过 `eventSource.setOrderConfig()` 或内置的 Hook Order 扩展配置
2. **监听器优先级**（`priority`）— `eventSource.on()` 的第三个参数，数字越大越先执行
3. **注册顺序** — 先注册的先执行

### 聊天生命周期事件

| 事件 | 触发时机 | 回调参数 |
|------|----------|----------|
| `CHAT_CHANGED` | 聊天切换完成 | `(chatId)` |
| `CHAT_CREATED` | 新聊天创建 | `(chatId)` |
| `GROUP_CHAT_CREATED` | 群组聊天创建 | `(chatId)` |
| `CHAT_BRANCH_CREATED` | 聊天分支或检查点创建 | `(payload)` — 见下文 |

### 消息事件

| 事件 | 触发时机 | 回调参数 |
|------|----------|----------|
| `USER_MESSAGE_RENDERED` | 用户消息渲染完成 | `(messageId)` |
| `CHARACTER_MESSAGE_RENDERED` | 角色消息渲染完成 | `(messageId)` |
| `MESSAGE_SENT` | 用户消息发送 | `(messageId)` |
| `MESSAGE_RECEIVED` | 收到 AI 回复 | `(messageId, type?)` |
| `MESSAGE_EDITED` | 消息被编辑 | `(messageId, meta?)` |
| `MESSAGE_UPDATED` | 消息块刷新 | `(messageId)` |
| `MESSAGE_DELETED` | 消息被删除 | `(chatLength, meta?)` |
| `MESSAGE_SWIPED` | 消息滑动切换 | `(messageId, meta?)` |
| `MESSAGE_SWIPE_DELETED` | 滑动选项被删除 | `({ messageId, swipeId, newSwipeId })` |

#### MESSAGE_RECEIVED 的 type 参数

`MESSAGE_RECEIVED` 的第二个参数 `type` 表示消息来源类型：

- 标准生成模式：`swipe`、`continue`、`append`、`appendfinal`
- 非标准来源：`first_message`、`command`、`extension`

#### MESSAGE_EDITED 的 meta 参数

```ts
(messageId: number, meta?: {
  messageId: number,
  playableSeq: number | null,
  assistantSeq: number | null,
  isUser: boolean,
  isAssistant: boolean,
  isSystem: boolean,
})
```

`meta` 参数是向后兼容的，可能不存在。当插件需要根据被编辑消息的位置或类型做出响应时使用。

#### MESSAGE_DELETED 的 meta 参数

```ts
(chatLength: number, meta?: {
  kind: 'delete',
  deletedPlayableSeqFrom: number | null,
  deletedPlayableSeqTo: number | null,
  deletedAssistantSeqFrom: number | null,
  deletedAssistantSeqTo: number | null,
})
```

#### MESSAGE_SWIPED 的 meta 参数

```ts
(messageId: number, meta?: {
  pendingGeneration: boolean,
  previousSwipeId: number | null,
  nextSwipeId: number | null,
})
```

#### CHAT_BRANCH_CREATED 的 payload

```ts
{
  mesId: number,                  // 分支/检查点消息索引
  branchName: string,             // 新分支或检查点聊天 ID / 文件名
  assistantMessageCount: number,  // 分支中包含的助手消息数
  sourceTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
  targetTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
}
```

`CHAT_BRANCH_CREATED` 在新分支或检查点聊天文件保存后、UI 切换到新聊天之前触发。如果你的插件存储了聊天绑定的状态数据，应在此事件中将状态复制或截断到新的分支或检查点。

### 生成钩子事件

生成钩子是插件介入 AI 生成流程的关键机制。它们按以下顺序触发：

```
GENERATION_STARTED
  ↓
GENERATION_CONTEXT_READY        ← 可调整 coreChat 和 maxContext
  ↓
GENERATION_BEFORE_WORLD_INFO_SCAN  ← 可影响世界书扫描
  ↓
GENERATION_AFTER_WORLD_INFO_SCAN   ← 世界书扫描完成
  ↓
GENERATION_WORLD_INFO_FINALIZED    ← 世界书最终确定
  ↓
GENERATION_BEFORE_API_REQUEST      ← 最终请求检查
  ↓
（API 请求发送）
  ↓
GENERATION_ENDED / GENERATION_STOPPED
```

#### 钩子选择指南

| 钩子 | 适合做什么 | 不适合做什么 |
|------|-----------|-------------|
| `GENERATION_CONTEXT_READY` | 裁剪/替换 `coreChat`，调整上下文限制 | 依赖世界书输出的逻辑 |
| `GENERATION_BEFORE_WORLD_INFO_SCAN` | 影响世界书扫描的临时修改 | 最终请求体编辑 |
| `GENERATION_WORLD_INFO_FINALIZED` | 读取最终世界书结果、深度注入 | 重建扫描前的聊天切片假设 |
| `GENERATION_BEFORE_API_REQUEST` | 最终请求检查、工具注入、Provider 特定附加 | 需要影响世界书激活的修改 |

#### GENERATION_CONTEXT_READY payload

```ts
{
  type: string,           // normal/continue/regenerate/swipe/...
  dryRun: boolean,
  isContinue: boolean,
  isImpersonate: boolean,
  coreChat: ChatMessage[],
  maxContext: number,
}
```

### 图像生成事件

`IMAGE_GENERATION_STARTED` 与 `IMAGE_GENERATION_ENDED` 在每一次图像生成请求上各触发一次。无论请求是正常完成、被中止还是出错，每个 STARTED 都恰好对应一个 ENDED；并发请求各自配对。两者都不携带任何参数。需要维护「当前是否在生成」状态的监听者应当做引用计数：STARTED 时 +1，ENDED 时 -1。

该契约覆盖通过内置图像生成扩展（Automatic1111、ComfyUI、NovelAI、Horde、OpenAI Images 等）调度的所有后端。提供自有图像生成管线的插件应遵循同样的契约：每次请求各 emit 一次 STARTED 与 ENDED；这样跨插件的功能（例如后台保活）就能统一处理任何来源的图像生成。

### APP_READY 事件

`APP_READY` 是一个特殊事件——它具有自动触发特性。如果监听器在应用启动后才注册，仍然会立即收到最后一次 `APP_READY` 的参数。这确保了延迟加载的插件也能正确初始化。

## 聊天状态

Luker 提供了聊天状态机制，让插件可以将数据绑定到特定聊天，而不是塞进 `chat_metadata`。

### 基本用法

```js
const context = Luker.getContext();
const NAMESPACE = 'my-plugin';

// 读取状态
const state = await context.getChatState(NAMESPACE);

// 更新状态（推荐方式）
await context.updateChatState(NAMESPACE, (current = {}) => ({
  ...current,
  lastUpdated: Date.now(),
  counter: (current.counter || 0) + 1,
}));

// 删除状态
await context.deleteChatState(NAMESPACE);
```

### 最佳实践

- 使用 `updateChatState()` 进行读-改-写操作，而不是手动链式调用 `getChatState()` + `patchChatState()`
- 保持命名空间 payload 为可 JSON 序列化的纯对象
- 对于大型插件数据，优先使用聊天状态而非 `chat_metadata`
- 处理 `ok: false` 返回值，保持插件 UI 的弹性

### 分支场景下的状态处理

```js
context.eventSource.on(context.eventTypes.CHAT_BRANCH_CREATED, async (payload) => {
  const sourceState = await context.getChatState(NAMESPACE, {
    target: payload.sourceTarget,
  });
  if (!sourceState) return;

  await context.updateChatState(NAMESPACE, () => ({
    ...sourceState,
    branch: {
      sourceMesId: payload.mesId,
      branchName: payload.branchName,
      copiedAt: Date.now(),
    },
  }), {
    target: payload.targetTarget,
  });
});
```

## UI 集成

### 设置面板

插件的设置面板通过 HTML 片段注入到扩展设置区域。使用 `inline-drawer` 类实现可折叠的设置面板：

```js
jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
  $('#extensions_settings').append(settingsHtml);

  // 绑定设置控件事件
  $('#my_plugin_enabled').on('change', function () {
    extension_settings[EXTENSION_NAME].enabled = $(this).prop('checked');
    saveSettingsDebounced();
  });

  // 初始化控件状态
  $('#my_plugin_enabled').prop('checked', extension_settings[EXTENSION_NAME].enabled);
});
```

### 弹窗对话框

Luker 提供了 `callGenericPopup` 等弹窗 API，用于显示自定义对话框：

```js
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const result = await callGenericPopup(
  '<div>自定义内容</div>',
  POPUP_TYPE.CONFIRM,
  '标题',
);
```

### 斜杠命令

插件可以注册自定义的斜杠命令：

```js
import { registerSlashCommand } from '../../../slash-commands.js';

registerSlashCommand(
  'myplugin',
  async (args, value) => {
    // 命令逻辑
    return '命令执行结果';
  },
  [],
  '执行 My Plugin 操作',
);
```

## 插件间通信

### registerExtensionApi

插件可以通过 `registerExtensionApi` 注册命名 API，供其他插件查找和调用：

```js
// 注册方
const context = Luker.getContext();
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});

// 调用方
const myPluginApi = context.getExtensionApi('my-plugin');
if (myPluginApi) {
  myPluginApi.doSomething();
}
```

## 调试技巧

### 浏览器开发者工具

- 在浏览器控制台中使用 `Luker.getContext()` 直接检查上下文对象
- 使用 `context.eventSource.getListenersMeta(eventName)` 查看某个事件的所有监听器信息
- 插件身份在排序/调试中通过扩展路径推断，包括第三方扩展（`third-party/<name>`）

### 前端日志管理器

Luker 内置了前端日志管理器，会拦截 `console` 输出和 `fetch` 请求。通过 `getFrontendLogsSnapshot()` 获取日志快照，支持按时间范围和 ID 过滤。详见[日志系统](/zh-CN/features/logging)。

### 常见问题排查

| 问题 | 排查方向 |
|------|----------|
| 插件未加载 | 检查 `manifest.json` 格式是否正确，`js` 路径是否存在 |
| 设置未保存 | 确认调用了 `saveSettingsDebounced()` |
| 事件未触发 | 使用 `getListenersMeta()` 确认监听器已注册 |
| 样式冲突 | 使用带插件前缀的 CSS 类名 |
| 状态丢失 | 确认使用了正确的命名空间，检查聊天状态是否写入成功 |

### 热重载

在开发过程中，可以通过扩展管理面板禁用/启用插件来触发重新加载。修改 `style.css` 后通常需要刷新页面。

## 相关页面

- [后端插件开发](/zh-CN/development/server-plugin) — 服务端插件开发指南（文件系统、API 代理、凭证存储）
- [Extension API 参考](/zh-CN/development/extension-api/) — 完整的 API 列表和详细参数说明
- [角色卡开发](/zh-CN/development/card-developers) — 角色卡扩展字段和 CardApp 开发
- [贡献指南](/zh-CN/development/contributing) — 如何向 Luker 提交代码
