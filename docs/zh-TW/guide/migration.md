# 從 SillyTavern 遷移

Luker 是 SillyTavern 的下游分支，保持了完整的資料相容性。從 SillyTavern 遷移到 Luker 只需幾個簡單步驟，你的所有資料都可以無縫使用。

::: tip 在 Android 上從 Termux 遷移？
本指南適用於 PC / Linux / Docker → Luker，以及 **Termux(SillyTavern) → Termux(Luker)**，兩端共用檔案系統，按下面步驟複製 `data/` 即可。

只有 **Termux → Luker APK** 因為 Android 沙盒隔離需要走 `/sdcard` 中轉，請參考 [從 Termux 遷移到 Luker APK](/zh-TW/guide/migration-from-termux)。
:::

## 遷移步驟

### 1. 備份現有資料

在遷移之前，建議備份 SillyTavern 的 `data/` 目錄：

```bash
cp -r SillyTavern/data/ SillyTavern-data-backup/
```

### 2. 安裝 Luker

按照 [快速開始](/zh-TW/guide/getting-started) 中的步驟安裝 Luker。

### 3. 複製資料目錄

將 SillyTavern 的 `data/` 目錄複製到 Luker 的資料根目錄下（預設為 `./data`）：

```bash
cp -r SillyTavern/data/* Luker/data/
```

如果你在 `config.yaml` 中自訂了 `dataRoot`，請複製到對應路徑。

### 4. 遷移設定檔

將 SillyTavern 的 `config.yaml` 中你自訂過的設定項遷移到 Luker 的 `config.yaml` 中。建議以 Luker 的預設設定檔為基礎，逐項遷移你的自訂值，而不是直接覆蓋整個檔案。

### 5. 遷移第三方擴充

如果你安裝了第三方擴充，將 SillyTavern 的全域擴充目錄複製到 Luker：

```bash
cp -r SillyTavern/public/scripts/extensions/third-party/* Luker/public/scripts/extensions/third-party/
```

### 6. 複製使用者設定（多使用者模式）

如果你啟用了多使用者模式（`enableUserAccounts: true`），使用者資料儲存在 `data/<使用者名稱>/` 子目錄中，目錄結構與 SillyTavern 一致，直接複製即可。

### 7. 啟動 Luker

```bash
node server.js
```

首次啟動時，Luker 會自動識別已有資料並正常載入。

## 資料相容性

Luker 與 SillyTavern 的資料格式完全相容，以下資料類型均可直接使用：

| 資料類型 | 相容性 | 說明 |
| --- | --- | --- |
| 角色卡（PNG/JSON） | ✅ 完全相容 | 支援 V1/V2 規範 |
| 聊天記錄（.jsonl） | ✅ 完全相容 | 增量同步端點向下相容 |
| 世界書（World Info） | ✅ 完全相容 | 條目格式不變 |
| 預設 | ✅ 完全相容 | Luker 會自動分離連線參數 |
| 使用者人設（Persona） | ✅ 完全相容 | — |
| 擴充設定 | ✅ 完全相容 | 第三方擴充照常運作 |
| 群聊 | ✅ 完全相容 | — |
| API 金鑰（secrets） | ✅ 完全相容 | `secrets.json` 格式不變 |

## Luker 新增的狀態檔案

Luker 在執行過程中會在資料目錄中產生一些額外的**狀態檔案**，用於儲存 Luker 獨有功能的資料：

- `.luker-state.<chat_id>.json` — 聊天狀態檔案，儲存增量同步的完整性校驗值等
- 角色卡狀態檔案 — 儲存角色綁定預設、記憶圖資料、編輯助手工作階段等
- 預設狀態檔案 — 儲存預設關聯的世界書等擴充狀態

這些檔案**不會影響 SillyTavern 的原始資料**。如果你需要將資料遷回 SillyTavern，只需忽略這些狀態檔案即可。SillyTavern 不會讀取它們，也不會因為它們的存在而出錯。

## 注意事項

1. **Node.js 版本**：Luker 要求 Node.js >= 20。遷移前請確認你的 Node.js 版本。

2. **第三方擴充**：SillyTavern 的第三方擴充在 Luker 中照常運作。Luker 使用相同的擴充載入機制，擴充目錄位於 `public/scripts/extensions/third-party/`。

3. **設定檔**：SillyTavern 的 `config.yaml` 與 Luker 的格式相容，但 Luker 新增了一些設定段（如 `sso`、`hostWhitelist` 等）。`requestProxy` 等設定項是 SillyTavern 已有的，無需額外處理。建議以 Luker 的預設 `config.yaml` 為基礎，將你的自訂設定遷移過來。詳見 [基礎設定](/zh-TW/guide/configuration)。

4. **預設解耦**：Luker 將 API 連線參數與預設分離。遷移後，你的預設仍然正常運作，Luker 會在載入時自動處理欄位分類。

5. **雙向相容**：由於 Luker 不修改 SillyTavern 的原始資料格式，你可以隨時在兩者之間切換。只需注意 Luker 獨有功能（如記憶圖、編排器）產生的資料在 SillyTavern 中不可用。

6. **Docker 部署**：如果你使用 Docker 部署，請參考 Luker 提供的 `docker-compose.yml` 參考設定，將資料目錄掛載為卷。
