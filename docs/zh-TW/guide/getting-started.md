# 快速開始

本指南將幫助你在幾分鐘內啟動並執行 Luker。

## 前置條件

| 依賴 | 要求 |
| --- | --- |
| **Node.js** | >= 20.0（僅 Git Clone 方式需要） |
| **Git** | 任意版本（僅 Git Clone 方式需要） |
| **Docker** | 任意現代版本（僅 Docker 方式需要） |

你還需要準備一個可用的 LLM API（OpenAI、Claude、Google Gemini、本機模型等）。

## 安裝方式一：Git Clone

適合希望自行管理和更新的使用者。

### 1. 複製儲存庫

```bash
git clone https://github.com/funnycups/Luker.git
cd Luker
```

### 2. 安裝依賴

```bash
npm install
```

### 3. 啟動服務

```bash
node server.js
```

你也可以使用儲存庫提供的啟動腳本，它會自動安裝依賴並啟動：

```bash
bash start.sh
```

::: tip 其他執行環境
Luker 也支援透過 Deno 或 Bun 啟動：
```bash
# Deno
npm run start:deno

# Bun
npm run start:bun
```
:::

### 4. 更新

```bash
git pull
npm install
```

## 安裝方式二：Docker

適合伺服器部署或希望開箱即用的使用者。Luker 提供了預建置的 Docker 映像檔。

### 1. 建立 `docker-compose.yml`

在你希望存放資料的目錄下建立 `docker-compose.yml`：

```yaml
services:
  luker:
    image: ghcr.io/funnycups/luker:latest
    container_name: luker
    ports:
      - 127.0.0.1:8000:8000
    volumes:
      - ./plugins:/home/node/app/plugins
      - ./config:/home/node/app/config
      - ./data:/home/node/app/data
      - ./extensions:/home/node/app/public/scripts/extensions/third-party
    restart: unless-stopped
```

### 2. 啟動容器

```bash
docker compose up -d
```

::: warning 連接埠綁定與安全防護
預設設定將連接埠綁定到 `127.0.0.1:8000`，僅允許本機存取。如需遠端存取，請將 `127.0.0.1:8000:8000` 改為 `0.0.0.0:8000:8000`，並確保做好以下安全防護：

- **反向代理 + HTTPS**：透過 Nginx 等反向代理提供 HTTPS 加密
- **啟用登入機制**：開啟 Basic Auth（`basicAuthMode: true`）或多使用者登入（`enableUserAccounts: true`），防止未授權存取。詳見 [基礎設定](/zh-TW/guide/configuration#認證與多使用者)
:::

### 3. 更新映像檔

```bash
docker compose pull
docker compose up -d
```

## 安裝方式三：Android APK

Luker 提供 Android APP，你可以直接在手機上執行 Luker，無需依賴雲端伺服器或 Termux。

前往 GitHub Release 頁面下載最新版 APK：

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

下載並安裝 APK 後，開啟應用即可直接使用。

## 首次設定

### 存取 Luker

啟動成功後，在瀏覽器中存取：

```
http://localhost:8000
```

::: tip Android 使用者
APK 版本是一個獨立的 App，開啟後直接顯示完整介面，不需要另外使用瀏覽器存取地址。
:::

### 設定 API 連線

首次進入 Luker 後，你需要設定至少一個 LLM API 才能開始對話：

1. 點擊頂部的 **API 連線** 圖示
2. 選擇你的 API 類型（如 OpenAI、Claude 等）
3. 填入 API 地址和金鑰
4. 測試連線是否成功

詳細說明請參閱 [API 連線設定](/zh-TW/basics/connections)。

### 選擇或匯入角色卡

設定好 API 後，你可以：

- 從角色卡列表中選擇一個角色開始對話
- 點擊 **匯入** 按鈕，匯入 `.png` 或 `.json` 格式的角色卡檔案

了解更多請參閱 [角色卡基礎](/zh-TW/basics/character-cards)。

## 從 SillyTavern 遷移

Luker 完全相容 SillyTavern 的資料。如果你是 SillyTavern 使用者，可以直接將 `data` 目錄複製到 Luker 中使用。如果之後不想用 Luker 了，也可以隨時降級回 SillyTavern，資料不會被破壞。

::: warning 備份提醒
雖然 Luker 相容 SillyTavern 資料，但在遷移前仍建議做好備份。
:::

詳細遷移指南請參閱 [從 SillyTavern 遷移](/zh-TW/guide/migration)。

## 下一步

- [設定 API 連線](/zh-TW/basics/connections) — 連接你的 LLM 服務
- [了解角色卡](/zh-TW/basics/character-cards) — 開始你的第一次角色扮演
- [從 SillyTavern 遷移](/zh-TW/guide/migration) — 如果你是 SillyTavern 使用者
