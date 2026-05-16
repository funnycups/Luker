# 從 Termux 原版酒館遷移到 Luker APK

如果你之前在 Termux 裡跑原版 SillyTavern，想換用 Luker 的 Android APK，這篇指南說明如何把原有資料搬到 APK 中。Luker 與 SillyTavern 資料格式完全相容，APK 在首次啟動時會彈出匯入精靈，正常情況下不需要碰 `Android/data` 私有目錄。

遷移完成後，你的角色卡、聊天紀錄、世界書、預設、使用者人設、擴充功能設定都會照常載入。

::: tip 適用場景
本指南面向「Termux 上的 SillyTavern → Luker APK」。PC / Linux / Docker 上的 SillyTavern 遷到 Luker 服務端、或者 Termux 之間互遷，請參考 [從 SillyTavern 遷移](/zh-TW/guide/migration)。
:::

## 推薦流程：首次啟動的匯入精靈

整套流程不需要檔案管理員進入 `Android/data/` 私有目錄。

### 1. 在 Termux 裡把資料打成 ZIP

如果 Termux 裡沒有 `zip` 命令，先裝一下：

```bash
pkg install zip
```

第一次跑還需要給 Termux 開儲存權限，這樣它才能寫到共用儲存：

```bash
termux-setup-storage
```

把 SillyTavern 的使用者資料目錄打成 ZIP，放到共用儲存的 `Download/`（系統檔案管理員能直接看到）：

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip default-user
```

如果你啟用了多使用者模式，把所有使用者子目錄一起打：

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip *
```

如果想把全域第三方擴充也帶過去，單獨打一份：

```bash
cd ~/SillyTavern/public/scripts/extensions
zip -r ~/storage/shared/Download/sillytavern-extensions.zip third-party
```

服務端 `config.yaml`（如果你之前在 Termux 裡改過連接埠、代理之類）也複製到同一個位置，等會兒一起選：

```bash
cp ~/SillyTavern/config.yaml ~/storage/shared/Download/sillytavern-config.yaml
```

::: tip ZIP 內部前綴寬容
Luker 的匯入邏輯會自動辨識 ZIP 裡 `characters/`、`chats/`、`worlds/` 這類子目錄，不管它前面套著 `data/default-user/...`、`default-user/...`、還是直接 `characters/...`，都能正確落到對應位置。
:::

### 2. 安裝 Luker APK 並觸發首次啟動精靈

從 [GitHub Releases](https://github.com/funnycups/Luker/releases/latest) 下載安裝最新 APK。

**首次開啟** Luker 會彈出標題為 **「歡迎來到 Luker!」** 的引導視窗。視窗頂部可以選介面語言（Language，預設英文，建議先切到「繁體中文」，下面的按鈕就會變中文），中間是一塊 **「從 SillyTavern 遷移」**，列出三個並排按鈕：

| 按鈕 | 用途 | 選什麼檔案 |
| --- | --- | --- |
| **「匯入 Data ZIP」** | 主遷移入口，匯入使用者資料（角色卡 / 聊天 / 世界書 / 預設 / 金鑰等） | 第 1 步打的 `sillytavern-data.zip` |
| **「匯入 config.yaml」** | 把原 SillyTavern 的服務端設定帶過來 | `sillytavern-config.yaml`（可選） |
| **「匯入全域擴充套件 ZIP」** | 全域第三方擴充 | `sillytavern-extensions.zip`（可選） |

按需點擊對應按鈕、在系統檔案選擇器裡挑檔案，等每個匯入提示完成即可。三個按鈕順序無所謂，互相獨立。

### 3. 完成精靈後進入 Luker

引導視窗要求填一個使用者名稱（用作預設人設名），完成後 Luker 會進入主介面。這時角色卡列表、聊天紀錄、世界書、預設、API 金鑰都應已經就位。

## 錯過了首次啟動精靈怎麼辦

如果你已經關掉了引導視窗（或者 Luker 已經用了一段時間想再次匯入），可以從使用者管理面板再走一次相同的匯入：

1. 開啟「使用者設定」→ 點「帳號」
2. 在使用者卡片上找 **「備份與還原」** 按鈕
3. 在面板裡點 **「全選」**，把所有資料類別都包含進來（也可以只勾你想還原的類別）
4. 點 **「選擇 ZIP」**，選中遷移 ZIP 檔案
5. 選還原模式 —— **「增量更新」**（按檔案路徑覆蓋，不刪別的）或 **「覆蓋更新」**（先清掉所選類別再還原）
6. 點 **「還原備份」**

「備份與還原」面板裡也包含同樣的「區域網遷移」、「下載備份 ZIP」等功能，詳見下文。

## 區域網遷移（雙方都已是 Luker 時）

如果你的源端已經是 Luker（另一台 Luker APK、或者 Termux 裡跑的服務端 Luker），目標端也是 Luker APK，可以走更輕鬆的區域網遷移，完全不用打 ZIP：

1. 源端「備份與還原」面板裡點 **「建立遷移連結」**，產生一次性連結
2. 目標端把連結貼進 **「從連結遷移」** 框，點匯入
3. 同區域網內自動傳輸 + 還原

連結是一次性的、很快過期。SillyTavern 原版沒有這個 UI，所以從原版 SillyTavern 來的遷移走不通——先按上面的 ZIP 流程到 Luker，之後的遷移就能用「區域網遷移」了。

## 兜底：手動複製到應用程式專屬目錄

只有以下情況才需要走這條路徑：

- 上面的 ZIP 流程出問題（匯入報錯、檔案管理員無法選到 ZIP）
- 你需要保留 Luker 匯入邏輯辨識不了的額外檔案
- 你想精確替換某個特定檔案而不是整體匯入

Luker APK 的資料目錄在 `/storage/emulated/0/Android/data/com.luker.app/files/luker-data/`，結構與 SillyTavern 的 `data/` 目錄一致。Android 11+ 對這個路徑加了存取限制，普通檔案管理員多半進不去，需要授權或換工具。

### 1. 在 Termux 裡把資料匯出到共用儲存

```bash
mkdir -p ~/storage/shared/Luker-migration
cp -r ~/SillyTavern/data ~/storage/shared/Luker-migration/
```

如果有第三方擴充也一起搬：

```bash
cp -r ~/SillyTavern/public/scripts/extensions/third-party \
      ~/storage/shared/Luker-migration/
```

### 2. 首次啟動 Luker APK 讓它建立資料目錄

開啟一次 APK 讓 `luker-data/` 目錄產生出來。這一步必須做，否則下面要複製的目標目錄還不存在。

### 3. 強制停止 Luker

進入系統設定 → 應用程式 → Luker → **強制停止**，確保 Luker 後台服務完全退出。遷移期間不要讓 Luker 在後台執行，否則它可能在你複製檔案的同時改寫資料。

### 4. 把資料搬進 Luker 資料目錄

打開手機檔案管理員，進入：

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/
```

把第 1 步匯出的 `data/` 目錄裡的 **全部內容** 複製進來——注意是把 `data/` **內部**的檔案和子目錄搬進 `luker-data/`，而不是把 `data/` 整個目錄搬進去。

遷移後 `luker-data/` 下應該看到：

- `default-user/`（或其他使用者名稱子目錄，多使用者模式下每個使用者一個）
- 預設使用者內部包含 `characters/`、`chats/`、`worlds/`、`OpenAI Settings/`、`User Settings/`、`secrets.json` 等

如果有第三方擴充，把 `third-party/` 目錄裡的內容搬到：

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/extensions/third-party/
```

::: warning 不要覆蓋 `_runtime-persist`
Luker APK 自己在 `luker-data/` 下維護一個 `_runtime-persist/` 目錄，存放執行時持久化產物。**不要覆蓋也不要刪除它**，從原版 SillyTavern 也不會帶來這個目錄。
:::

### 5. 重啟 Luker，驗證資料

重新打開 Luker APK。等待載入完成後角色卡列表、聊天紀錄、世界書、預設、API 連線都應自動還原。

### 檔案管理員無法存取 Android/data？

Android 11 及以上版本對 `Android/data/` 目錄加了存取限制，不同手機廠商的處理方式不同：

- **小米 / 紅米（MIUI / HyperOS）**：自帶「檔案管理」可以打開 `Android/data`，第一次進入會要求授權
- **OPPO / 一加 / Realme（ColorOS）、vivo（OriginOS / FuntouchOS）、華為 / 榮耀**：自家檔案管理員一般可以存取，部分需要在「設定 → 隱私 → 特殊權限」中授予「檔案管理權限」
- **三星（One UI）**：自帶「我的檔案」可存取，部分版本需要長按目錄授權
- **原生 Android / Pixel**：Google 自家 Files 預設不允許存取，需要換用第三方

如果你的檔案管理員無法進入 `Android/data/com.luker.app/`，可選方案：

- **第三方檔案管理員**：MT 管理器、MiXplorer、Solid Explorer、Material Files（開源）等對 `Android/data` 支援較好
- **電腦 USB 中轉**：用 USB 線連接手機和電腦選「檔案傳輸 / MTP」模式，在電腦上拖動檔案
- **ADB 推送**：`adb push ./data/. /sdcard/Android/data/com.luker.app/files/luker-data/`，速度最快也最不容易出錯

## 資料目錄速查

| 內容 | Termux 原路徑 | Luker APK 目標路徑 |
| --- | --- | --- |
| 資料根目錄 | `~/SillyTavern/data/` | `…/com.luker.app/files/luker-data/` |
| 角色卡 | `data/<user>/characters/` | `luker-data/<user>/characters/` |
| 聊天紀錄 | `data/<user>/chats/` | `luker-data/<user>/chats/` |
| 世界書 | `data/<user>/worlds/` | `luker-data/<user>/worlds/` |
| 預設 | `data/<user>/OpenAI Settings/` 等 | 同名子目錄 |
| API 金鑰 | `data/<user>/secrets.json` | 同名 |
| 第三方擴充 | `public/scripts/extensions/third-party/` | `luker-data/extensions/third-party/` |
| 伺服器外掛 | `plugins/` | `luker-data/plugins/` |

`<user>` 在單一使用者模式下通常是 `default-user`；多使用者模式下每個帳號對應一個子目錄，目錄結構相同。

## 常見問題

**首次啟動沒有看到歡迎引導視窗**

引導只在全新資料目錄上首次開啟時彈出。如果 Luker 之前已經被開啟過，從使用者管理面板的「備份與還原」做同樣的匯入即可——點「全選」，選 ZIP，選「增量更新」，然後點「還原備份」。

**「還原備份」報錯說封存檔不匹配選定的還原類別**

ZIP 內部完全找不到 `characters/`、`chats/`、`worlds/` 這類子目錄。檢查一下打 ZIP 時的工作目錄——`zip -r ... default-user` 是正確的；從 `~/SillyTavern` 直接 `zip -r ... data` 也行；但從 `~/` 直接 `zip -r ... SillyTavern` 把外面的原始碼全包進去就會失敗。

**重啟 Luker 後角色卡列表是空的（手動複製流程）**

檢查複製層級：`luker-data/` 下應直接出現 `default-user/`（或其他使用者名稱目錄），而不是嵌套的 `luker-data/data/default-user/`。如果出現了重複的 `data/` 一層，把裡面的內容上移一級。

**Luker 啟動後白屏 / 報錯（手動複製流程）**

可能是 `_runtime-persist/` 被覆蓋或破壞。可以嘗試：① 刪除 `_runtime-persist/` 讓 Luker 自動重建；② 仍有問題時進入「應用程式資訊 → 儲存空間 → 清除資料」並重新走一遍遷移流程。

**第三方擴充未載入**

確認擴充放在 `luker-data/extensions/third-party/<extension-name>/` 這一層。每個擴充都是一個目錄，裡面包含 `manifest.json`。

## 與 SillyTavern 雙向相容

遷移後 Luker 不會修改原 SillyTavern 資料格式，只在 `data/` 中追加自己的狀態檔案（如 `.luker-state.<chat_id>.json` 等）。如果你之後又想回到 Termux 上的 SillyTavern，把 `luker-data/` 的內容拷回去即可，SillyTavern 會忽略它無法辨識的狀態檔案。

更詳細的相容性說明見 [從 SillyTavern 遷移](/zh-TW/guide/migration#資料相容性)。

## 相關頁面

- [Android App](/zh-TW/guide/android) — APK 版本介紹
- [快速開始](/zh-TW/guide/getting-started) — Luker 安裝總覽
- [從 SillyTavern 遷移](/zh-TW/guide/migration) — 服務端版本遷移指南
