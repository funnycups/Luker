---
description: Luker 提供桌面版應用，讓 macOS、Windows 與 Linux 使用者以獨立應用的形式執行完整的 Luker 服務與介面。指南說明下載、安裝、首次啟動的系統安全提示放行、資料目錄位置與卸載。
---

# 桌面端 App

Luker 提供桌面版應用，讓 macOS、Windows 與 Linux 使用者以獨立應用的形式執行完整的 Luker 服務與介面。開啟應用即可直接顯示完整的 Luker 介面，不需要另外使用瀏覽器存取地址。

## 下載方式

前往 GitHub Releases 頁面下載最新版：

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

發佈版本同時提供 macOS、Windows 與 Linux 的安裝包與免安裝包，檔名包含版本、平台與架構，例如 `Luker-2.8.0-mac-arm64.dmg`。

| 檔名 | 說明 |
| --- | --- |
| `Luker-<version>-mac-<arch>.dmg` | macOS 磁碟映像，把應用拖入「應用程式」資料夾 |
| `Luker-<version>-mac-<arch>.zip` | macOS 壓縮檔，內容相同，解壓縮到任意位置即可 |
| `Luker-<version>-win-<arch>.exe` | Windows 安裝包，安裝應用並建立捷徑 |
| `Luker-<version>-win-<arch>.zip` | Windows 免安裝壓縮檔，解壓縮後直接執行 |
| `Luker-<version>-linux-x86_64.AppImage` 與 `Luker-<version>-linux-arm64.AppImage` | Linux 免安裝包，`chmod +x` 後直接執行，不依賴發行版 |
| `Luker-<version>-linux-amd64.deb` 與 `Luker-<version>-linux-arm64.deb` | Debian 與 Ubuntu 安裝包 |
| `Luker-<version>-linux-x86_64.rpm` 與 `Luker-<version>-linux-aarch64.rpm` | Fedora 與 openSUSE 安裝包 |

`<arch>` 在 Apple Silicon Mac 與 Windows on ARM 上為 `arm64`，在 Intel Mac 與 Intel 或 AMD 處理器的 Windows 上為 `x64`。請選擇與你的裝置匹配的檔案。

Linux 的檔名按格式採用不同的架構寫法：`.AppImage` 為 `x86_64` 與 `arm64`，`.deb` 為 `amd64` 與 `arm64`，`.rpm` 為 `x86_64` 與 `aarch64`。

## 安裝

安裝包與免安裝包任選其一即可。

### macOS

- **`.dmg`**：開啟後把 **Luker** 拖入「應用程式」資料夾。
- **`.zip`**：解壓縮後把 `Luker.app` 移入「應用程式」資料夾。

### Windows

- **`.exe`**：執行後依安裝精靈操作。
- **`.zip`**：解壓縮後直接執行資料夾裡的 `Luker.exe`。

防毒軟體有時會誤報 `.exe`，因為安裝包沒有程式碼簽章。遇到這種情況，放行後重新執行即可。

### Linux

- **`.AppImage`**：執行 `chmod +x` 後直接執行。
- **`.deb`**：交給套件管理器安裝。
- **`.rpm`**：交給套件管理器安裝。

Ubuntu 24.04 及之後，AppImage 可能需要在啟動參數裡加上 `--no-sandbox` 才能啟動。`.deb` 與 `.rpm` 安裝後不需要。

## 首次啟動

應用未使用付費程式碼簽章憑證，因此 macOS 與 Windows 在首次開啟時都會顯示安全提示。這是正常現象，放行後應用即可正常執行。

### macOS

macOS 會以無法驗證應用為由阻止首次啟動。前往**系統設定** → **隱私權與安全性**，找到關於 Luker 的提示，點擊**仍要打開**，並在隨後的對話框中確認。

### Windows

SmartScreen 會顯示「Windows 已保護您的電腦」視窗，發行者顯示為未知。點擊**其他資訊**，再點擊**仍要執行**。

## 資料目錄

應用把自身資料全部存放在同一個目錄下：

| 平台 | 位置 |
| --- | --- |
| macOS | `~/Library/Application Support/Luker` |
| Windows | `%APPDATA%\Luker` |
| Linux | `~/.config/Luker` |

目錄內的內容：

- `config.yaml`：伺服器設定檔
- `data/`：聊天、預設、世界書的儲存根目錄
- `backups/`：聊天備份
- `plugins/`：伺服器端外掛
- `extensions/third-party/`：第三方擴充

### 變更資料目錄

開啟**使用者設定** → **帳號** → **儲存**，找到**資料目錄**，點擊**變更**。選擇空目錄或既有的 Luker 資料目錄。該目錄由 Luker 獨占，並且需要有足夠的可用空間存放目前資料。

應用程式會把聊天、備份、外掛、擴充與伺服器設定遷移到所選目錄並重新啟動。遷移完成後，應用程式刪除舊資料。目標目錄在啟動時無法使用時，應用程式會提示重試、重新選擇目錄或結束，不會退回預設目錄。

瀏覽器登入狀態與快取不會遷移。啟用多使用者帳號時，遷移後需要重新登入。

## 卸載

卸載應用只移除應用程式本身，不會刪除資料目錄，安裝包與免安裝包均如此。應用程式會保留所選資料位置的記錄，重新安裝後會繼續使用同一目錄。聊天、預設與設定均會保留。

若要一併清除全部資料，卸載後手動刪除上方的資料目錄。

## 關閉視窗

在 Windows 與 macOS 上，關閉視窗不會結束應用程式：伺服器與仍在生成的回覆會在背景繼續，重新開啟視窗回到原本的頁面。結束時從選單結束應用程式。

Windows 上關閉視窗會把應用程式收進通知區域，系統匣選單可以開啟視窗、開啟資料目錄、結束應用程式。Windows 11 會把新的通知區域圖示收進摺疊面板，首次關閉後圖示可能在那裡。

macOS 上關閉視窗後應用程式留在 Dock，點擊 Dock 圖示重新開啟視窗，透過「Luker」選單的「開啟資料目錄」進入資料目錄，⌘Q 結束應用程式。

Linux 上沒有系統匣，關閉視窗就是結束應用程式，伺服器也會一併停止。

## 儲存後端

桌面版支援 `fs`、`mysql`、`postgres` 儲存後端。`sqlite` 後端不受支援，本機儲存請使用 `fs`。

## 從原始碼執行

在程式碼倉庫中執行 `npm run start:electron` 會以倉庫裡的程式碼啟動同一個應用。它使用與安裝版相同的資料目錄，而不是倉庫裡的 `./data`，因此寫入的設定、聊天與預設互相可見。

## 更新

有新版本時，應用會在介面裡顯示更新提示。點擊**下載更新**會把當前平台的安裝包交給系統安裝程式。

Linux 上 AppImage 會被就地替換，替換完成後提示重啟應用程式。`.deb` 與 `.rpm` 更新會交給系統安裝程式。

## 相關頁面

- [快速開始](/zh-TW/guide/getting-started) —— 完整的安裝指南
- [基礎設定](/zh-TW/guide/configuration) —— 設定項說明
- [儲存後端](/zh-TW/guide/configuration#儲存後端) —— 伺服器支援的儲存後端
