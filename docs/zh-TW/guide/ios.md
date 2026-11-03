# iOS

Luker 可以在 iPhone 與 iPad 上以自簽名應用程式的方式執行。應用程式內建後端，開啟後直接顯示與桌面版相同的介面，不需要另外執行伺服器。

## 為什麼不在 App Store 上架

Luker 以 AGPL-3.0 授權。App Store 的條款與該授權要求的自由複製、修改和再散布衝突，構成[應用程式商店的法律障礙](https://en.wikipedia.org/wiki/GNU_General_Public_License#Legal_barrier_to_application_stores)，因此 Luker 不透過 App Store 散布。iOS 安裝包以未簽名 IPA 發布，由你用自己的 Apple ID 簽名。

## 準備

- iPhone 或 iPad，iOS 16 或更高版本。
- 一台電腦，用於首次安裝 AltStore 或 SideStore。
- 一個 Apple ID。免費帳號即可。付費開發者帳號可以把簽名有效期從 7 天延長到 1 年。
- 從 GitHub Releases 下載的未簽名 IPA。

## 下載

從 [GitHub Releases](https://github.com/funnycups/Luker/releases/latest) 下載最新的 iOS 安裝包，檔案名稱以 `-ios-unsigned.ipa` 結尾。

## 安裝

1. 在 iPhone 或 iPad 上安裝 AltStore 或 SideStore，依 [altstore.io](https://altstore.io/) 或 [sidestore.io](https://sidestore.io/) 的引導完成首次設定。AltStore Classic 需要電腦執行 AltServer；SideStore 在設定時產生配對檔案。
2. 把 IPA 儲存到裝置。
3. 在 AltStore 或 SideStore 中開啟 IPA，登入 Apple ID，開始簽名。
4. 打開「設定」→「一般」→「VPN 與裝置管理」，信任開發者憑證。
5. 如果 iOS 提示，打開「設定」→「隱私權與安全性」→「開發者模式」，開啟後重新啟動裝置。
6. 打開 Luker。

::: warning
免費 Apple ID 的簽名 7 天後過期，裝置上最多同時保留 3 個自簽名應用程式。到期前重新簽名即可。付費開發者帳號的簽名為 1 年。
:::

## 首次啟動

Luker 會啟動本機伺服器並開啟介面。首次啟動需要一點時間準備本機環境。API 連線、角色卡匯入等操作與桌面版相同。

應用程式在本機執行。安裝完成後不需要電腦或遠端伺服器。

## 背景生成與通知

在使用者設定中開啟「後台保活」後，生成會在 Luker 進入背景時繼續執行。系統資源緊張時 iOS 可能暫停應用程式，因此不保證生成一定完成。

開啟「當 Luker 在背景時，訊息生成完成後顯示通知。」後，回覆在背景完成時會傳送本機通知。開啟開關時系統會要求通知權限。僅在 Luker 執行時傳送通知。

啟動失敗或應用程式異常退出時，Luker 會提示匯出診斷包。診斷包包含原生記錄、崩潰報告、內建服務記錄與網頁主控台記錄。

## 限制

- 背景生成是盡力而為。iOS 在資源緊張時可能暫停應用程式。
- 更新從 GitHub Releases 下載並重新簽名。建議使用同一個 Apple ID 簽名並覆蓋安裝。
- 如果需要更換簽名用的 Apple ID，請先[備份資料](/zh-TW/features/user-settings-additions#備份、遷移與儲存)，再解除安裝舊版應用程式並安裝新版本。

這裡指的是替 App 簽名用的 Apple ID；裝置上登入的 iCloud 或 App Store 帳號不影響更新。

## 用瀏覽器存取 Luker

也可以不安裝應用程式，直接在瀏覽器中使用 Luker。在一台電腦上執行 Luker，然後在 Safari 中開啟：

1. 在電腦上開啟網路存取：
   - 同一網路內 —— 見[區域網路存取](/zh-TW/guide/lan-access)。
   - 從網路之外 —— 見[遠端存取](/zh-TW/guide/remote-access)。
2. 在 iPhone 或 iPad 上開啟 Safari，輸入主機地址。區域網路內形如 `http://192.168.1.23:8000`；經代理或隧道存取時，輸入你的網域。
3. 若啟用了身分驗證，需先登入。

## 加入主畫面

Luker 可以作為主畫面圖示安裝，開啟時在自己的視窗中執行，而不是瀏覽器分頁。

1. 在 Safari 中開啟 Luker。
2. 點一下**分享**按鈕。
3. 點一下**加入主畫面**。
4. 命名後點一下**加入**。

圖示會在獨立視窗中開啟 Luker，不顯示 Safari 網址列，並使用 Luker 圖示。

## 相關頁面

- [區域網路存取](/zh-TW/guide/lan-access) —— 讓同一網路內的裝置存取 Luker
- [遠端存取](/zh-TW/guide/remote-access) —— 從網路之外存取 Luker
- [Android App](/zh-TW/guide/android) —— Android 平台的應用程式
- [HarmonyOS App](/zh-TW/guide/harmonyos) —— HarmonyOS 平台的應用程式
- [桌面端 App](/zh-TW/guide/desktop) —— 桌面平台的應用程式
