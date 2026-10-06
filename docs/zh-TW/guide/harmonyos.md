# HarmonyOS App

> **為什麼必須自己建置？** 鴻蒙的開發者工具必須登入華為帳號才能下載，且其授權禁止再散布。公開 CI 服務因此無法合法建置鴻蒙應用，也就沒有可直接安裝的 HAP 可供下載——只能從原始碼建置。簽名與安裝同樣依賴這套工具，每一步都繞不開華為開發者帳號。若鴻蒙生態允許，Luker 會直接發佈現成的 HAP。

Luker 提供了鴻蒙應用，讓你可以直接在裝置上執行完整的 Luker 服務與介面，無需依賴雲端伺服器或終端工具。

## 概述

安裝 HAP 後，開啟應用即可直接顯示完整的 Luker 介面，不需要另外使用瀏覽器存取地址。應用內建了完整的 Luker 伺服器端和前端，是一個獨立執行的應用。

## 從原始碼建置

### 先決條件

- Node.js 24 或更高版本
- DevEco Studio，安裝並登入一次，它提供鴻蒙工具鏈與 `hvigorw`

### macOS 與 Linux

```bash
git clone https://github.com/funnycups/Luker.git
cd Luker
bash harmony-app/scripts/build.sh
```

### Windows

```powershell
git clone https://github.com/funnycups/Luker.git
cd Luker
powershell -ExecutionPolicy Bypass -File harmony-app\scripts\build.ps1
```

建置完成後，未簽名的 HAP 位於 `harmony-app/entry/build/default/outputs/default/entry-default-unsigned.hap`。

## 簽名與安裝

### 1. 建立簽名憑證

在 DevEco Studio 裡產生金鑰與憑證請求檔：依序選擇 **Build** → **Generate Key and CSR**，設定金鑰庫名稱與路徑、金鑰庫密碼、金鑰別名與金鑰密碼。

隨後在 AppGallery Connect 建立憑證與描述檔：

1. 登入 [AppGallery Connect](https://developer.huawei.com/consumer/en/service/josp/agc/index.html)，進入 **憑證、App ID 和 Profile**。
2. 在 **憑證** 下建立 **偵錯** 憑證，上傳 `.csr` 檔案，下載產生的 `.cer` 檔案。
3. 連接裝置，執行 `hdc shell bm get --udid` 讀取裝置 UDID。在 **裝置** 下用該 UDID 新增裝置。
4. 在 **Profile** 下為套件名稱 `com.luker.harmony` 建立 **偵錯** 描述檔，選擇憑證與裝置，下載 `.p7b` 檔案。

### 2. 簽名 HAP

用鴻蒙 SDK 裡的 `hap-sign-tool.jar` 為建置出的 HAP 簽名：

```bash
java -jar hap-sign-tool.jar sign-app \
  -keyAlias <金鑰別名> \
  -signAlg SHA256withECDSA \
  -mode localSign \
  -appCertFile <憑證>.cer \
  -profileFile <描述檔>.p7b \
  -inFile entry-default-unsigned.hap \
  -keystoreFile <金鑰庫>.p12 \
  -outFile luker-signed.hap \
  -keyPwd <金鑰密碼> \
  -keystorePwd <金鑰庫密碼>
```

### 3. 安裝 HAP

在裝置上啟用 **開發者選項** 與 **USB 偵錯**，連接裝置後安裝：

```bash
hdc install -r luker-signed.hap
```

::: tip
也可以用 DevEco Studio 完成簽名與安裝：開啟專案，在 **File** → **Project Structure** → **Signing Configs** 裡設定自動簽名，再在已連接的裝置上執行應用。
:::

::: warning
偵錯描述檔只能安裝到其中已登記 UDID 的裝置。若要在另一台裝置上安裝，需在 AppGallery Connect 裡把該裝置加入描述檔並重新下載。
:::

## 使用方式

安裝完成後，開啟 Luker 應用：

1. 應用會自動啟動內建的 Luker 服務
2. 介面載入完成後，你會看到與桌面版完全相同的 Luker 介面
3. 設定 API 連線、匯入角色卡、開始對話——所有操作與桌面版一致

你不需要手動輸入任何地址或連接埠，應用會自動處理一切。

## 與桌面版的功能差異

鴻蒙版本與桌面版在功能上基本一致，你可以使用所有核心功能，包括多 API 連線、角色卡管理、世界書、預設等。

由於行動裝置的螢幕尺寸和互動方式不同，部分介面佈局會自動適配行動端顯示。

## 相關頁面

- [快速開始](/zh-TW/guide/getting-started) — 完整的安裝指南
- [基礎設定](/zh-TW/guide/configuration) — 設定項說明
