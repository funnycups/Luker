# 外掛整合

把外掛接入 Luker 流水線、以及外掛之間互通的 API：正則處理、搜尋工具、跨外掛 API 註冊表、事件系統。

## 正則執行時 API

外掛可以透過 `registerManagedRegexProvider()` 註冊託管的正則處理器，參與 Luker 的正則處理流程。該函數從正則引擎模組匯出：

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
  // ...其他正則腳本欄位
});

// 卸载时取消註冊
handle.unregister();
```

`registerManagedRegexProvider` 回傳的句柄提供 `upsertScript`、`removeScript`、`setScripts`、`clearScripts` 和 `unregister` 方法。

## 搜尋工具 API

搜尋外掛透過 `Luker.searchTools` 全域物件暴露 API，供其他外掛呼叫搜尋能力：

```js
// 檢查搜尋外掛是否可用
if (globalThis?.Luker?.searchTools) {
  // 取得可用的搜尋工具名稱列表
  const toolNames = Luker.searchTools.toolNames;
  // 取得工具定義（用於函數呼叫）
  const toolDefs = Luker.searchTools.getToolDefs();
  // 檢查某個工具名是否屬於搜尋工具
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` 暴露的是工具定義中繼資料，實際的搜尋執行透過內部的工具呼叫迴圈完成。詳見[搜尋外掛](/zh-TW/features/search-tools)。

## 擴充功能間通訊

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

將一個API物件註冊到指定名稱下，供其他擴充功能透過`getExtensionApi`取得。如果同名API已被註冊，會在控制台輸出警告並覆蓋。

### getExtensionApi

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

按名稱取得其他擴充功能註冊的API物件。如果該名稱尚未註冊，返回`undefined`。

### 典型用途

擴充功能間通訊最常見的場景是解耦：一個擴充功能提供能力，另一個擴充功能消費能力，而不需要硬編碼依賴。例如，CardApp Studio透過`registerExtensionApi`將自身的編輯器API暴露出來，其他擴充功能可以在Studio就緒後直接呼叫。

## 事件系統

### eventSource

```js
// 監聽
context.eventSource.on(eventName, handler, options?);

// 取消監聽
context.eventSource.off(eventName, handler);

// 確保最先執行
context.eventSource.makeFirst(eventName, handler);

// 確保最后執行
context.eventSource.makeLast(eventName, handler);

// 查看監聽器資訊（除錯用）
context.eventSource.getListenersMeta(eventName);

// 設定外掛排序
context.eventSource.setOrderConfig(config);
```

### 監聽器選項

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // 數字越大越先執行
});
```

### 事件類型

所有事件類型透過 `context.eventTypes` 存取。完整的事件列表和回呼參數請參閱[前端外掛開發](/zh-TW/development/frontend-plugin#事件系統)。
