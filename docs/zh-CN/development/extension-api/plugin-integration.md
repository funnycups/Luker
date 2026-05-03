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

所有事件类型通过 `context.eventTypes` 访问。完整的事件列表和回调参数请参阅[前端插件开发](/zh-CN/development/frontend-plugin#事件系统)。
