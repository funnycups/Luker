# 鉤子執行排序

鉤子執行排序（Hook Order）允許使用者自訂擴充功能的執行優先順序。在 SillyTavern 的擴充功能系統中，多個擴充功能可以註冊同一個事件鉤子（如訊息生成前、訊息生成後等），Hook Order 讓你控制這些鉤子的執行順序。

該功能作為內建擴充功能提供。

## 為什麼需要排序

### 擴充功能之間的依賴關係

當多個擴充功能同時監聽同一個事件時，它們的執行順序可能會影響最終結果。例如：

- 一個擴充功能負責翻譯使用者輸入，另一個擴充功能負責內容過濾——翻譯應該在過濾之前執行
- 一個擴充功能修改提示詞格式，另一個擴充功能新增額外上下文——格式化應該在新增上下文之後執行
- [記憶圖](/zh-TW/features/memory-graph)需要在[多 Agent 編排](/zh-TW/features/orchestrator/)之前完成記憶檢索

如果沒有明確的執行順序控制，擴充功能之間的互動可能產生不可預期的結果。

### 第三方擴充功能相容

Hook Order 支援第三方擴充功能的 ID 識別，你可以將第三方擴充功能納入排序管理，確保它們與內建擴充功能之間的執行順序符合預期。

## 上下移動排序介面

Hook Order 在擴充功能面板裡按事件類型分組展示，每個擴充功能有上移 / 下移按鈕，列表頂部的擴充功能先執行：

![Hook 順序面板](/images/hook-order/hook-order-panel.png)

```d2
direction: right

EVT: "generation_after_world_info_scan 觸發"
H1: "memory-graph 完成記憶檢索" {
  style.fill: "#e1f5ff"
}
H2: "search-tools 寫入搜尋結果到世界書" {
  style.fill: "#fff3e0"
}
NEXT: "繼續下一階段"

EVT -> H1 -> H2 -> NEXT
```

上圖就是面板裡 `世界書掃描後` 那一組——`memory-graph` 排在 `search-tools` 之前，意味著記憶檢索先跑、搜尋結果後寫入。這一輪的記憶檢索看不到 `search-tools` 當輪新寫入的世界書條目；如果你希望搜尋結果參與本輪的記憶檢索，把 `search-tools` 上移到 `memory-graph` 之前即可。

## 排序介面元素

- **事件分組** — 每個事件（如 `generation_before_world_info_scan`、`generation_after_world_info_scan`）獨立維護一份排序，互不影響
- **上移 / 下移** — 調整該事件下擴充功能的執行順序
- **重置為偵測到的順序** — 按程式碼掃描到的註冊順序恢復

## 設定持久化

排序設定會持久化儲存到設定中。重新啟動應用程式後，擴充功能的執行順序會按照你上次設定的順序恢復，無需重複設定。

## 相關功能

- [多 Agent 編排](/zh-TW/features/orchestrator/) — 編排器的多個 Agent 節點也有執行順序
- [記憶圖](/zh-TW/features/memory-graph) — 記憶檢索的時機受鉤子順序影響
