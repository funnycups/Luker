# CardApp

CardApp 是 Luker 独有的角色卡内嵌应用系统。它允许角色卡在 `data.extensions` 中定义小型应用（包含 HTML、JavaScript 和样式），这些应用会在聊天界面中加载和渲染，为角色卡赋予交互式的动态能力。

CardApp 系统由入口注册、应用加载器、渲染器和上下文 API 四个模块组成。

::: tip 开发 CardApp
推荐使用[角色卡编辑助手](/zh-CN/features/card-editor)中的 **CardApp Studio** 来开发和调试 CardApp。Studio 提供了 CodeMirror 6 代码编辑器、实时预览和 Markdown 渲染，是创建 CardApp 的最佳工具。
:::

## 架构

```
index.js (入口/注册)
  ├── loader.js   (加载应用定义)
  ├── renderer.js (渲染/生命周期)
  └── context.js  (受限 API 上下文)
```

### 入口模块（index.js）

- 通过 `registerExtensionApi('card-app', api)` 注册扩展 API，供其他扩展调用
- 监听角色切换事件，自动触发应用的加载与卸载
- 注册扩展 API（`isActive`、`reloadCardApp`），供其他扩展调用

### 加载器（loader.js）

- 从角色卡的 `data.extensions` 字段提取应用定义
- 验证应用格式和安全性
- 解析应用的 HTML 内容、脚本、样式和元数据

### 渲染器（renderer.js）

- 将应用渲染到聊天界面的指定容器中
- 处理应用之间的隔离，防止相互干扰

### 上下文 API（context.js）

上下文 API 是 CardApp 的核心模块。CardApp 通过 Luker 提供的上下文 API 与宿主交互，建议开发者遵循最小权限原则，仅使用官方 API 而非直接操作 DOM：

- **只读数据访问**：应用可以读取角色信息、聊天历史等数据，但不应直接修改核心状态
- **有限交互能力**：提供受控的交互接口，如发送消息
- **最小权限原则**：建议仅通过官方 API 访问所需功能，避免直接操作宿主 DOM

## 生命周期管理

CardApp 遵循标准的组件生命周期：

1. **挂载（Mount）**：角色切换时，加载器从角色卡提取应用定义，渲染器将应用挂载到 UI 容器
2. **更新（Update）**：应用运行期间，可通过上下文 API 响应聊天事件并更新自身状态
3. **卸载（Unmount）**：切换到其他角色或关闭聊天时，渲染器清理应用实例并释放资源

## 使用场景

### 角色卡内嵌互动元素

角色卡作者可以在卡片中嵌入自定义的互动 UI，例如角色状态面板、情绪指示器或自定义按钮，让用户与角色的交互更加丰富。

### 小游戏

利用 CardApp 的 HTML/JS 能力，角色卡可以内嵌简单的小游戏，如文字冒险的选择界面、骰子投掷器或卡牌游戏组件。

### 状态追踪

通过 `getChatState` / `setChatState` API，CardApp 可以持久化追踪与当前聊天相关的状态数据，例如好感度、任务进度、物品清单等，这些数据在会话之间保持不变。


## 相关功能

- [角色卡编辑器](/zh-CN/features/card-editor) — 编辑角色卡数据，包括 CardApp 定义
- [多Agent编排](/zh-CN/features/orchestrator) — 编排器同样使用扩展 API 机制
