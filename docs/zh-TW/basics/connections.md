# API 連線

Luker 本身不包含 AI 模型，它透過 API 連線到外部的大型語言模型（LLM）服務來產生回覆。本頁介紹如何設定和管理 API 連線。

## 支援的 API 類型

Luker 支援多種主流的 LLM API：

### Chat Completion（聊天補全）

| API 供應商 | 說明 |
|-----------|------|
| **OpenAI** | GPT 系列模型（如 GPT-5 等） |
| **Anthropic** | Claude 系列模型 |
| **Google AI Studio / Vertex AI** | Gemini 系列模型 |
| **OpenRouter** | 聚合多家模型的中轉服務 |
| **自訂 OpenAI 相容 API** | 任何相容 OpenAI API 格式的服務（如各類中轉站） |

### Text Completion（文字補全）

| API 供應商 | 說明 |
|-----------|------|
| **KoboldAI** | 本機執行的開源模型 |
| **Ollama** | 本機模型管理和推理工具 |
| **llama.cpp / TabbyAPI** | 本機推理後端 |
| **Text Generation WebUI** | Oobabooga 的 Web 介面 |

::: info
Chat Completion 和 Text Completion 是兩種不同的 API 模式。大多數商業 API（OpenAI、Claude、Gemini）使用 Chat Completion 模式；本機模型通常兩種都支援。如果你不確定，Chat Completion 是更常用的選擇。
:::

## 連線管理器

Luker 提供了**連線管理器**（Connection Manager）來管理多個 API 連線配置。

### 建立連線配置

1. 開啟設定面板，找到連線管理器
2. 點擊「新建配置」
3. 填寫配置名稱（例如「Claude Sonnet 4.5」「GPT-5」）
4. 選擇 API 類型並填寫連線參數
5. 儲存配置

### 切換連線

在連線管理器的下拉清單中選擇不同的配置即可一鍵切換。切換連線不會影響你當前使用的聊天補全預設。

### 管理多個連線

你可以建立任意數量的連線配置，例如：

- 一個用於日常對話的低成本模型
- 一個用於高品質創作的旗艦模型
- 一個用於本機模型的配置

透過連線管理器可以在它們之間快速切換，無需每次都重新填寫 API 位址和金鑰。

## API 金鑰配置

### 取得 API 金鑰

每個 API 供應商都有自己的金鑰取得方式：

- **OpenAI**：在 [platform.openai.com](https://platform.openai.com) 建立 API Key
- **Anthropic**：在 [console.anthropic.com](https://console.anthropic.com) 建立 API Key
- **Google**：在 [aistudio.google.com](https://aistudio.google.com) 取得 API Key
- **OpenRouter**：在 [openrouter.ai](https://openrouter.ai) 註冊並取得 Key

### 填寫金鑰

在連線配置中填入對應的 API 金鑰。金鑰會安全地儲存在 Luker 的伺服器端，不會在前端暴露。

::: tip
如果你使用的是自行部署的 Luker 實例，API 金鑰儲存在你自己的伺服器上。如果使用他人提供的 Luker 實例，請注意金鑰安全。
:::

## 模型選擇

設定好 API 連線後，你需要選擇要使用的具體模型。Luker 會根據 API 類型動態載入可用的模型清單。

對於 Claude 和 Gemini 等 API，Luker 支援**動態模型清單**——自動從 API 取得最新的可用模型，無需手動更新。你也可以為每個 API 來源自訂模型清單。詳見[其他改進](/zh-TW/improvements/other)。

## OpenRouter 上的 Gemini 歷史快取

在 **OpenRouter Gemini 提示快取**區域，啟用**快取穩定的聊天歷史**後，Luker 會顯式快取一段包含系統提示、摘要和較早對話訊息的前綴。此功能預設關閉，僅對宣告支援顯式快取的 OpenRouter Gemini 模型生效；直連 Google AI Studio/Vertex 以及其他模型保持原有行為。

**不快取最近幾輪**預設為 **2** 個完整回合，目前輸入也始終不快取。如果正則或擴充功能會隨深度變化改寫較早的訊息，請調大此值。邊界從最終發出的訊息中選取，因此連續的 user 訊息算作一個回合，工具結果不算新的 user 回合。訊息文字、角色、摘要位置、工具呼叫和多媒體內容均保持不變。

Gemini 對普通訊息內容只使用最後一個顯式快取標記。因此 Luker 將一個標記固定在相同的歷史位置，而不是每輪都向後推進，並在每次重用前檢查前綴。五分鐘後，或者編輯、swipe、摘要替換、上下文裁剪、系統提示或工具定義改變了該前綴時，會選取新的邊界。新訊息在下次重新整理前始終位於固定前綴之外。調大不快取尾部設定也會在下次請求時生效。

已有的**快取 system prompt**開關適用於歷史不足的短請求。歷史快取啟用時，Luker 只放置一個歷史標記，不再新增與之競爭的系統標記。其他擴充功能提供的顯式標記會被保留並優先生效。

這些設定隨連線配置保存，也可以用 `/gemini-enable-history-cache` 和 `/gemini-cache-keep-recent-turns` 讀取或修改。不經過 UI 的後端呼叫可以在 `config.yaml` 中使用 `gemini.enableHistoryCache` 和 `gemini.cacheKeepRecentTurns`。

### 檢查效果

在請求檢查器中查看最終發出的請求：被選中的歷史訊息的最後一個文字塊應包含 `cache_control: { "type": "ephemeral" }`。伺服器日誌會報告本地邊界計畫的狀態：`created`、`reused`、`refreshed`、`no-history` 或 `external-breakpoint`。**邊界被重用並不代表提供商快取命中。** 請跨多個回合檢查 OpenRouter 返回的 `usage.prompt_tokens_details.cached_tokens`、快取寫入次數和總費用。

OpenRouter 文件說明 Gemini 顯式快取有五分鐘的生命週期，且快取寫入和儲存都會計費。快取前綴較大時，如果頻繁重建或只用一次，費用可能反而更高。長時間停頓、上游路由、最小快取長度和伺服器重新啟動都會降低重用率。Luker 只在記憶體中保存有界的、按使用者/憑證/工作階段隔離的雜湊和位置，不保存提供商快取物件；它無法保證命中，也無法控制上游快取的生命週期。參見 [OpenRouter 的 Gemini 快取文件](https://openrouter.ai/docs/guides/best-practices/prompt-caching#google-gemini)。

## 代理設定

如果你需要透過代理（Reverse Proxy）存取 API，可以在連線配置中設定：

- **代理位址**：中轉服務的 URL
- **代理密碼**：中轉服務的認證密碼（如果需要）

代理設定是連線配置的一部分，不同的連線配置可以使用不同的代理。

## 與預設解耦的關係

在 Luker 中，API 連線和聊天補全預設是**完全獨立**的兩個概念：

- **連線配置**管理的是「用哪個 API、哪個模型、透過什麼位址存取」
- **聊天補全預設**管理的是「用什麼提示詞、什麼取樣參數」

你可以自由組合它們。例如：

- 用同一個 Claude API 連線，搭配不同的預設來切換寫作風格
- 用同一套精心調教的預設，在 OpenAI 和 Claude 之間切換對比效果

這種解耦設計讓你可以獨立地優化連線和預設，互不干擾。

詳見 [預設系統](/zh-TW/basics/presets) 和 [預設解耦](/zh-TW/improvements/preset-decoupling)。

## 斜線命令

Luker 的連線管理器提供了斜線命令，方便進階使用者快速操作：

| 命令 | 說明 |
|------|------|
| `/profile [名稱]` | 切換到指定連線配置，或查看當前配置名 |
| `/profile-list` | 列出所有連線配置 |
| `/profile-create <名稱>` | 用當前設定建立新配置 |
| `/profile-update` | 更新當前選中的配置 |

## 請求檢查器

Luker 內建了請求檢查器（Request Inspector），可以查看每次產生請求的詳細資訊，包括傳送給 API 的完整請求內容和回傳的回應。這在除錯連線問題或優化提示詞時非常有用。

## 下一步

- 了解 [預設系統](/zh-TW/basics/presets) 如何控制 AI 的回覆行為
- 了解 [角色卡](/zh-TW/basics/character-cards) 的基本概念
- 了解 [聊天管理](/zh-TW/basics/chat-management) 的基本操作
