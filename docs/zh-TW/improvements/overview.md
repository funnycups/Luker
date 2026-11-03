# 改進總覽

Luker 在 SillyTavern 的基礎上改造了資料儲存、預設組織、生成請求處理和擴充能力。本頁說明這些改動解決什麼問題，以及它們對日常使用帶來什麼變化。具體設定步驟在各自頁面中。

## 改進一覽

| 分類 | 改進 | 解決的問題 |
| --- | --- | --- |
| 架構 | [預設解耦](/zh-TW/improvements/preset-decoupling) | 切換預設不再連帶更換 API 連線 |
| 架構 | [增量同步](/zh-TW/improvements/incremental-sync) | 儲存時只傳輸變化，減少流量與並行衝突 |
| 架構 | [後端即時儲存](/zh-TW/improvements/backend-storage) | 操作後立即寫入磁碟，瀏覽器崩潰不遺失資料 |
| 功能 | [函式呼叫執行環境](/zh-TW/improvements/function-call-runtime) | 原生與純文字模型都能呼叫工具 |
| 功能 | [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets) | 角色卡攜帶作者推薦的生成設定 |
| 功能 | [請求檢查器](/zh-TW/improvements/request-inspector) | 查看每次請求的輸入、輸出與 Token 用量 |
| 功能 | [預設關聯世界書](/zh-TW/improvements/preset-world-info) | 切換預設時自動啟用對應世界書 |
| 功能 | [Skills](/zh-TW/features/skills/) | 把長提示詞拆成依需要讀取的知識包 |
| 基礎設施 | [統一生成層](/zh-TW/improvements/generation-layer) | 不同後端共享同一套請求處理 |
| 基礎設施 | [效能最佳化](/zh-TW/improvements/performance) | 更快的啟動、載入與日常操作 |
| 基礎設施 | [WebSocket 代理](/zh-TW/improvements/ws-proxy) | 不穩定網路中保持生成不中斷 |
| 基礎設施 | [驗證與配額](/zh-TW/improvements/auth-and-quota) | 多人共享執行個體時的登入與容量管理 |
| 基礎設施 | [其他改進](/zh-TW/improvements/other) | 連線管理、分組、動態模型清單等 |

記憶圖、多 Agent 編排、角色卡編輯助手、搜尋外掛和 CardApp 屬於 Luker 的獨有功能，見[獨有功能](/zh-TW/features/memory-graph)。

## 架構改進

### 預設解耦

SillyTavern 把 API 連線參數和生成預設放在同一個設定物件裡。切換模型或服務商時，取樣參數和提示詞設定會跟著改變；調整取樣參數也可能意外影響連線。

Luker 把兩者拆開：**連線設定**負責連到哪裡，**預設**負責怎麼生成。同一套預設可以搭配不同連線，同一個連線也可以搭配不同預設。角色卡綁定預設、API 連線設定等功能都建立在這個拆分之上。

詳見[預設解耦](/zh-TW/improvements/preset-decoupling)。

### 增量同步

傳統儲存會把完整物件傳送到伺服器。聊天越長，每次儲存傳輸的資料越多，並行寫入也越容易互相覆蓋。

Luker 只傳送發生變化的部分：新訊息附加、單則訊息修補、中繼資料合併。伺服器在寫入後校驗資料完整性，發現並行修改時拒絕覆蓋。設定儲存同樣採用增量方式，並帶衝突偵測。

詳見[增量同步](/zh-TW/improvements/incremental-sync)。

### 後端即時儲存

SillyTavern 的部分資料要等前端觸發才儲存，這之間存在「已經操作但還沒寫入磁碟」的窗口。行程異常結束時，這段時間的修改會遺失。

Luker 把儲存職責移到伺服器：資料到達即持久化，前端不再決定什麼時候儲存。聊天寫入依序執行，群聊等並行情境不會互相破壞；生成完成後會確認結果已經記錄。還可以設定聊天檔案的自動備份。

詳見[後端即時儲存](/zh-TW/improvements/backend-storage)。

## 功能增強

### 函式呼叫執行環境

不同模型對工具呼叫的支援不一致。有的原生支援結構化呼叫，有的只能在文字裡寫出呼叫意圖。

Luker 提供統一的函式呼叫執行環境：原生支援時使用模型自帶的能力，不支援時用提示詞引導並在本機解析。兩種方式對外掛和使用者呈現相同的工具，連線設定中可以個別調整純文字模式的開關與重試。

詳見[函式呼叫執行環境](/zh-TW/improvements/function-call-runtime)。

### 角色卡綁定預設與人設

角色卡作者最清楚角色在什麼參數下表現最好。Luker 允許角色卡攜帶推薦預設和預設人設；載入角色時自動套用，離開時回復之前的設定。綁定預設會在選擇器中標記，並隨角色卡匯出。

詳見[角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets)。

### 請求檢查器

想知道一次生成到底傳送了什麼、消耗了多少 Token，可以開啟請求檢查器。它記錄請求的輸入、輸出、耗時和 Token 用量，涵蓋串流回覆、圖像生成、向量嵌入和重排。Token 統計與儲存配額彼此獨立。

詳見[請求檢查器](/zh-TW/improvements/request-inspector)。

### Skills

編排器裡的系統提示詞會隨著規則增多而膨脹。Skills 把可重複使用的寫作規則、評審方法和工作流拆成獨立知識包，Agent 需要時依名稱讀取。

Skill 可以隨角色卡或預設一起分發，接收方不需要另外安裝。Director 的預設設定已經使用該機制。概念見 [Skills 概覽](/zh-TW/features/skills/)，寫法見[創作 Skill](/zh-TW/features/skills/authoring)。

## 基礎設施

### 統一生成層

不同 AI 後端的請求路徑原本各自實作，功能支援不一致。統一生成層把請求處理收斂到一處，讓所有後端共享 Token 計量、串流處理、錯誤處理和生成確認。無論使用哪家服務，請求檢查器和用量統計的行為一致。

詳見[統一生成層](/zh-TW/improvements/generation-layer)。

### 驗證與配額

多人共享執行個體時，管理員可以開啟 GitHub 或 Discord 登入，為不同使用者設定儲存配額，並透過日誌查看伺服器活動。OAuth 在管理員面板中設定，不需要手寫設定檔。

詳見[驗證與配額](/zh-TW/improvements/auth-and-quota)。

### 其他改進

API 連線設定、WebSocket 代理、HTTP 代理、預設與提示詞分組、復原提示、動態模型清單、擴充鉤子排序、角色與預設狀態、啟動效能等改動，彙總在[其他改進](/zh-TW/improvements/other)。
